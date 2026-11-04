#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <node_api.h>
#include <vector>
#include <mutex>

// Sample delivery and interval boundaries share this queue. Device setup and
// AVAssetExportSession waiting run on N-API workers, never on that queue.
static dispatch_queue_t mediaQueue;
static std::mutex deviceMutex;
static double hostNow() {
  return CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1000;
}
static NSException *failure(NSString *s) {
  return [NSException exceptionWithName:@"RecordingMedia" reason:s userInfo:nil];
}
static void check(BOOL ok, NSString *s) {
  if (!ok) @throw failure(s);
}
static CMTime timeMs(double ms) {
  return CMTimeMake(llround(ms * 60), 60000);
}
static void wavHeader(FILE *f, uint32_t bytes, uint32_t rate, uint16_t channels) {
  uint8_t h[44] = {0};
  memcpy(h, "RIFF", 4);
  uint32_t size = bytes + 36;
  memcpy(h + 4, &size, 4);
  memcpy(h + 8, "WAVEfmt ", 8);
  uint32_t fmt = 16;
  memcpy(h + 16, &fmt, 4);
  uint16_t pcm = 1, bits = 16;
  memcpy(h + 20, &pcm, 2);
  memcpy(h + 22, &channels, 2);
  memcpy(h + 24, &rate, 4);
  uint32_t speed = rate * channels * 2;
  memcpy(h + 28, &speed, 4);
  uint16_t block = channels * 2;
  memcpy(h + 32, &block, 2);
  memcpy(h + 34, &bits, 2);
  memcpy(h + 36, "data", 4);
  memcpy(h + 40, &bytes, 4);
  fseek(f, 0, SEEK_SET);
  check(fwrite(h, 1, 44, f) == 44, @"无法更新录音文件头");
  fflush(f);
  fseek(f, 0, SEEK_END);
}
@interface RecordingSession : NSObject <SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate,
                                        AVCaptureVideoDataOutputSampleBufferDelegate>
@property NSString *sessionId, *directory, *deviceError;
@property SCStream *stream;
@property AVCaptureSession *capture;
@property AVCaptureDeviceInput *videoInput;
@property AVCaptureVideoDataOutput *videoOutput;
@property BOOL closing, cameraStarting;
@property NSString *cameraError;
@property NSMutableArray<NSMutableDictionary *> *intervals, *audio;
@property NSMutableArray<NSDictionary *> *cameras;
@property NSMutableDictionary<NSString *, NSMutableDictionary *> *currentAudio;
@property BOOL active, begun, cameraEnabled, cameraReady, microphoneReady, systemReady;
@property id runtimeObserver;
@property dispatch_semaphore_t readiness;
@property double activeStart, hostStart, stoppedAt;
- (NSDictionary *)manifest;
- (void)persist;
- (void)receiveAudio:(CMSampleBufferRef)sample source:(NSString *)source host:(double)host;
@end
static RecordingSession *session;
@implementation RecordingSession
- (instancetype)init {
  if ((self = [super init])) {
    _intervals = [NSMutableArray new];
    _audio = [NSMutableArray new];
    _cameras = [NSMutableArray new];
    _currentAudio = [NSMutableDictionary new];
    _readiness = dispatch_semaphore_create(0);
  }
  return self;
}
- (double)duration {
  return self.active ? self.activeStart + hostNow() - self.hostStart : self.activeStart;
}
- (NSDictionary *)manifest {
  NSMutableArray *intervals = [self.intervals mutableCopy];
  double duration = [self duration];
  if (self.active)
    [intervals addObject:[@{
                 @"hostStartMs" : @(self.hostStart),
                 @"hostEndMs" : @(self.hostStart + duration - self.activeStart),
                 @"activeStartMs" : @(self.activeStart),
                 @"activeEndMs" : @(duration)
               } mutableCopy]];
  return @{
    @"version" : @1,
    @"sessionId" : self.sessionId,
    @"durationMs" : @(duration),
    @"intervals" : intervals,
    @"audio" : [[NSArray alloc] initWithArray:self.audio copyItems:YES]
  };
}
- (void)persist {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:[self manifest] options:0 error:&error];
  check(data && [data writeToFile:[self.directory stringByAppendingPathComponent:@"media.json"]
                          options:NSDataWritingAtomic
                            error:&error],
        error.localizedDescription ?: @"无法保存录音索引");
}
- (void)closeInterval:(double)host {
  if (!self.active) return;
  double end = self.activeStart + host - self.hostStart;
  [self.intervals addObject:[@{
                    @"hostStartMs" : @(self.hostStart),
                    @"hostEndMs" : @(host),
                    @"activeStartMs" : @(self.activeStart),
                    @"activeEndMs" : @(end)
                  } mutableCopy]];
  self.activeStart = end;
  self.active = NO;
  [self.currentAudio removeAllObjects];
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  self.deviceError = error.localizedDescription;
  [self closeInterval:hostNow()];
  @try {
    [self persist];
  } @catch (NSException *e) {
    self.deviceError = e.reason;
  }
}
- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sample
           fromConnection:(AVCaptureConnection *)connection {
  @try {
    if (self.closing || !self.capture) return;
    if ([output isKindOfClass:AVCaptureVideoDataOutput.class] && output != self.videoOutput) return;
    CMClockRef clock = self.capture.synchronizationClock;
    check(clock != nil, @"采集设备时钟不可用");
    double host = CMTimeGetSeconds(CMSyncConvertTime(CMSampleBufferGetPresentationTimeStamp(sample), clock,
                                                     CMClockGetHostTimeClock())) *
                  1000;
    if ([output isKindOfClass:AVCaptureAudioDataOutput.class]) {
      if (!self.microphoneReady) {
        self.microphoneReady = YES;
        dispatch_semaphore_signal(self.readiness);
      }
      [self receiveAudio:sample source:@"microphone" host:host];
      return;
    }
    CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample);
    if (!pixel) return;
    CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(pixel), height = CVPixelBufferGetHeight(pixel),
           stride = CVPixelBufferGetBytesPerRow(pixel);
    NSMutableData *data = [NSMutableData dataWithLength:width * height * 4];
    for (size_t y = 0; y < height; y++)
      memcpy((uint8_t *)data.mutableBytes + y * width * 4, (uint8_t *)CVPixelBufferGetBaseAddress(pixel) + y * stride,
             width * 4);
    CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
    if (!self.cameraReady) {
      self.cameraReady = YES;
      dispatch_semaphore_signal(self.readiness);
    }
    [self.cameras addObject:@{@"host" : @(host), @"width" : @(width), @"height" : @(height), @"data" : data}];
    while (self.cameras.count > 1 && [self.cameras[0][@"host"] doubleValue] < host - 2000)
      [self.cameras removeObjectAtIndex:0];
  } @catch (NSException *e) {
    if (self.cameraStarting && [output isKindOfClass:AVCaptureVideoDataOutput.class])
      self.cameraError = e.reason;
    else self.deviceError = e.reason;
    dispatch_semaphore_signal(self.readiness);
  }
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeAudio) return;
  if (!self.systemReady) {
    self.systemReady = YES;
    dispatch_semaphore_signal(self.readiness);
  }
  @try {
    [self receiveAudio:sample
                source:@"system"
                  host:CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000];
  } @catch (NSException *e) {
    self.deviceError = e.reason;
  }
}
- (void)receiveAudio:(CMSampleBufferRef)sample source:(NSString *)source host:(double)host {
  if (!self.begun || !CMSampleBufferDataIsReady(sample)) return;
  const AudioStreamBasicDescription *asbd =
      CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
  check(asbd && asbd->mSampleRate > 0, @"无效音频格式");
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithStreamDescription:asbd];
  CMItemCount count = CMSampleBufferGetNumSamples(sample);
  AVAudioPCMBuffer *input = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)count];
  input.frameLength = (AVAudioFrameCount)count;
  check(CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, 0, (int32_t)count, input.mutableAudioBufferList) == noErr,
        @"无法读取音频样本");
  AVAudioFormat *outFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                                              sampleRate:asbd->mSampleRate
                                                                channels:asbd->mChannelsPerFrame
                                                             interleaved:YES];
  AVAudioPCMBuffer *pcm = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outFormat frameCapacity:(AVAudioFrameCount)count];
  AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:format toFormat:outFormat];
  NSError *error = nil;
  check([converter convertToBuffer:pcm fromBuffer:input error:&error],
        error.localizedDescription ?: @"无法转换录音格式");
  double rate = outFormat.sampleRate, end = host + pcm.frameLength * 1000 / rate;
  NSMutableArray *ranges = [self.intervals mutableCopy];
  if (self.active)
    [ranges addObject:[@{
              @"hostStartMs" : @(self.hostStart),
              @"hostEndMs" : @(hostNow()),
              @"activeStartMs" : @(self.activeStart)
            } mutableCopy]];
  for (NSDictionary *range in ranges) {
    double lo = MAX(host, [range[@"hostStartMs"] doubleValue]), hi = MIN(end, [range[@"hostEndMs"] doubleValue]);
    if (hi <= lo) continue;
    size_t first = MIN(pcm.frameLength, (size_t)MAX(0, ceil((lo - host) * rate / 1000 - 1e-6))),
           last = MIN(pcm.frameLength, (size_t)MAX(0, ceil((hi - host) * rate / 1000 - 1e-6)));
    if (last <= first) continue;
    double start =
        [range[@"activeStartMs"] doubleValue] + host + first * 1000 / rate - [range[@"hostStartMs"] doubleValue];
    NSMutableDictionary *segment = self.currentAudio[source];
    if (!segment || fabs(start - [segment[@"startMs"] doubleValue] - [segment[@"durationMs"] doubleValue]) > 1.5 ||
        [segment[@"sampleRate"] doubleValue] != rate ||
        [segment[@"channels"] unsignedIntValue] != outFormat.channelCount) {
      NSString *file = [NSString stringWithFormat:@"%@-%lu.wav", source, (unsigned long)self.audio.count];
      segment = [@{
        @"source" : source,
        @"file" : file,
        @"startMs" : @(start),
        @"durationMs" : @0,
        @"sampleRate" : @(rate),
        @"channels" : @(outFormat.channelCount)
      } mutableCopy];
      [self.audio addObject:segment];
      self.currentAudio[source] = segment;
    }
    NSString *path = [self.directory stringByAppendingPathComponent:segment[@"file"]];
    FILE *f = fopen(path.fileSystemRepresentation, "r+b");
    if (!f) {
      f = fopen(path.fileSystemRepresentation, "w+b");
      check(f != nullptr, @"无法创建录音文件");
      wavHeader(f, 0, (uint32_t)rate, outFormat.channelCount);
    }
    fseek(f, 0, SEEK_END);
    size_t bytes = (last - first) * outFormat.channelCount * 2;
    BOOL ok = fwrite((uint8_t *)pcm.audioBufferList->mBuffers[0].mData + first * outFormat.channelCount * 2, 1, bytes,
                     f) == bytes;
    long length = ftell(f);
    if (ok) wavHeader(f, (uint32_t)(length - 44), (uint32_t)rate, outFormat.channelCount);
    fclose(f);
    check(ok, @"无法保存录音样本");
    segment[@"durationMs"] = @((length - 44) * 1000.0 / (rate * outFormat.channelCount * 2));
  }
  [self persist];
}
@end

static void permission(AVMediaType type, RecordingSession *s = nil) {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:type];
  if (status == AVAuthorizationStatusNotDetermined) {
    dispatch_semaphore_t done = s ? s.readiness : dispatch_semaphore_create(0);
    __block BOOL granted = NO, completed = NO;
    [AVCaptureDevice requestAccessForMediaType:type
                             completionHandler:^(BOOL value) {
                               dispatch_sync(mediaQueue, ^{ granted = value; completed = YES; });
                               dispatch_semaphore_signal(done);
                             }];
    while (true) {
      __block BOOL finished, closing;
      dispatch_sync(mediaQueue, ^{ finished = completed; closing = s.closing; });
      check(!closing, @"录制媒体会话已失效");
      if (finished) break;
      dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    }
    check(granted, @"录屏设备权限未获允许");
  } else
    check(status == AVAuthorizationStatusAuthorized, @"请在系统设置允许麦克风或摄像头权限");
}
// These helpers run under deviceMutex on a worker. Only delivery state uses mediaQueue.
static void ensureCapture(RecordingSession *s) {
  if (s.capture) return;
  s.capture = [AVCaptureSession new];
  __weak RecordingSession *weakSession = s;
  s.runtimeObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:AVCaptureSessionRuntimeErrorNotification object:s.capture queue:nil
      usingBlock:^(NSNotification *notification) {
        dispatch_async(mediaQueue, ^{
          RecordingSession *strong = weakSession;
          if (!strong || strong.closing) return;
          NSString *error = [notification.userInfo[AVCaptureSessionErrorKey] localizedDescription] ?: @"录制设备已断开";
          if (strong.cameraStarting) strong.cameraError = error;
          else strong.deviceError = error;
          dispatch_semaphore_signal(strong.readiness);
        });
      }];
}
static void addVideo(RecordingSession *s) {
  ensureCapture(s);
  AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  check(device != nil, @"未找到摄像头");
  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
  output.videoSettings = @{(id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA)};
  output.alwaysDiscardsLateVideoFrames = YES;
  [s.capture beginConfiguration];
  @try {
    check(input && [s.capture canAddInput:input], error.localizedDescription ?: @"无法连接摄像头");
    [s.capture addInput:input];
    s.videoInput = input;
    check([s.capture canAddOutput:output], @"无法连接摄像头输出");
    dispatch_sync(mediaQueue, ^{ s.videoOutput = output; });
    [output setSampleBufferDelegate:s queue:mediaQueue];
    [s.capture addOutput:output];
  } @finally { [s.capture commitConfiguration]; }
}
static void removeVideo(RecordingSession *s) {
  AVCaptureVideoDataOutput *output = s.videoOutput;
  [output setSampleBufferDelegate:nil queue:nullptr];
  dispatch_sync(mediaQueue, ^{
    s.videoOutput = nil;
    s.cameraEnabled = NO;
    s.cameraReady = NO;
    [s.cameras removeAllObjects];
  });
  [s.capture beginConfiguration];
  if (output && [s.capture.outputs containsObject:output]) [s.capture removeOutput:output];
  if (s.videoInput) [s.capture removeInput:s.videoInput];
  s.videoInput = nil;
  [s.capture commitConfiguration];
  if (!s.capture.inputs.count) [s.capture stopRunning];
  dispatch_sync(mediaQueue, ^{ s.cameraStarting = NO; s.cameraError = nil; });
}
static void waitReady(RecordingSession *s, BOOL system, BOOL microphone, BOOL camera) {
  double deadline = hostNow() + 8000;
  while (true) {
    __block BOOL ready, closing;
    __block NSString *error;
    dispatch_sync(mediaQueue, ^{
      ready = (!system || s.systemReady) && (!microphone || s.microphoneReady) && (!camera || s.cameraReady);
      closing = s.closing;
      error = s.deviceError ?: s.cameraError;
    });
    check(!closing, @"录制媒体会话已失效");
    check(!error, error);
    if (ready) return;
    double remaining = deadline - hostNow();
    check(remaining > 0, @"录制设备未能提供样本");
    dispatch_semaphore_wait(s.readiness, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(remaining * NSEC_PER_MSEC)));
  }
}
static void setCamera(NSDictionary *options) {
  __block RecordingSession *s;
  __block BOOL valid, enabled;
  dispatch_sync(mediaQueue, ^{
    s = session;
    valid = s && [s.sessionId isEqual:options[@"sessionId"]] && !s.closing;
    enabled = s.cameraEnabled;
  });
  check(valid, @"录制媒体会话已失效");
  if (enabled == [options[@"enabled"] boolValue]) return;
  if (![options[@"enabled"] boolValue]) { removeVideo(s); return; }
  @try {
    permission(AVMediaTypeVideo, s);
    dispatch_sync(mediaQueue, ^{ valid = !s.closing; s.cameraStarting = valid; });
    check(valid, @"录制媒体会话已失效");
    addVideo(s);
    dispatch_sync(mediaQueue, ^{ valid = !s.closing; });
    check(valid, @"录制媒体会话已失效");
    [s.capture startRunning];
    check(s.capture.running, @"设备未能启动");
    waitReady(s, NO, NO, YES);
    dispatch_sync(mediaQueue, ^{
      valid = !s.closing;
      s.cameraEnabled = valid;
      s.cameraStarting = NO;
    });
    check(valid, @"录制媒体会话已失效");
  } @catch (NSException *e) {
    removeVideo(s);
    @throw e;
  }
}
static void releaseDevices(RecordingSession *s) {
  if (s.runtimeObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:s.runtimeObserver];
    s.runtimeObserver = nil;
  }
  if (s.stream) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [s.stream stopCaptureWithCompletionHandler:^(NSError *e) {
      dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    s.stream = nil;
  }
  removeVideo(s);
  [s.capture stopRunning];
  dispatch_sync(mediaQueue, ^{
    s.capture = nil;
    [s.cameras removeAllObjects];
  });
}
static void prepare(NSDictionary *options) {
  __block BOOL occupied;
  dispatch_sync(mediaQueue, ^{
    occupied = session != nil;
  });
  check(!occupied, @"已有录制媒体会话");
  RecordingSession *s = [RecordingSession new];
  s.sessionId = options[@"sessionId"];
  s.directory = options[@"directory"];
  check(s.sessionId.length && s.directory.length, @"缺少录制会话路径");
  s.cameraEnabled = [options[@"camera"] boolValue];
  @try {
    if ([options[@"microphone"] boolValue]) permission(AVMediaTypeAudio);
    if (s.cameraEnabled) permission(AVMediaTypeVideo);
    if ([options[@"systemAudio"] boolValue]) {
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block SCShareableContent *content;
      __block NSError *error;
      [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                                 onScreenWindowsOnly:YES
                                                   completionHandler:^(SCShareableContent *c, NSError *e) {
                                                     content = c;
                                                     error = e;
                                                     dispatch_semaphore_signal(done);
                                                   }];
      dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
      check(content != nil, error.localizedDescription ?: @"无法访问屏幕声音");
      SCDisplay *display = nil;
      for (SCDisplay *d in content.displays)
        if (d.displayID == [options[@"displayId"] unsignedIntValue]) display = d;
      check(display != nil, @"录屏显示器不可用");
      SCStreamConfiguration *config = [SCStreamConfiguration new];
      config.capturesAudio = YES;
      config.excludesCurrentProcessAudio = NO;
      config.sampleRate = 48000;
      config.channelCount = 2;
      config.width = 2;
      config.height = 2;
      config.minimumFrameInterval = CMTimeMake(1, 1);
      s.stream = [[SCStream alloc] initWithFilter:[[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]]
                                    configuration:config
                                         delegate:s];
      check([s.stream addStreamOutput:s type:SCStreamOutputTypeAudio sampleHandlerQueue:mediaQueue error:&error],
            error.localizedDescription);
      [s.stream startCaptureWithCompletionHandler:^(NSError *e) {
        error = e;
        dispatch_semaphore_signal(done);
      }];
      dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
      check(error == nil, error.localizedDescription);
    }
    if ([options[@"microphone"] boolValue] || s.cameraEnabled) {
      ensureCapture(s);
      if ([options[@"microphone"] boolValue]) {
        AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
        check(device != nil, @"未找到麦克风");
        NSError *error = nil;
        AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
        check(input && [s.capture canAddInput:input], error.localizedDescription ?: @"无法连接录制设备");
        [s.capture addInput:input];
        AVCaptureAudioDataOutput *out = [AVCaptureAudioDataOutput new];
        [out setSampleBufferDelegate:s queue:mediaQueue];
        check([s.capture canAddOutput:out], @"无法连接麦克风输出");
        [s.capture addOutput:out];
      }
      if (s.cameraEnabled) addVideo(s);
      [s.capture startRunning];
      check(s.capture.running, @"设备未能启动");
    }
    // Preparation includes the first sample, so countdown cannot race device startup.
    waitReady(s, [options[@"systemAudio"] boolValue], [options[@"microphone"] boolValue], s.cameraEnabled);
    dispatch_sync(mediaQueue, ^{
      session = s;
    });
  } @catch (NSException *e) {
    releaseDevices(s);
    @throw e;
  }
}
static void mux(NSDictionary *options) {
  double start = [options[@"trimStartMs"] doubleValue], end = [options[@"trimEndMs"] doubleValue];
  check(end > start && start >= 0, @"无效裁剪区间");
  CMTime duration = timeMs(end - start);
  AVMutableComposition *composition = [AVMutableComposition composition];
  NSError *error = nil;
  AVURLAsset *video = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:options[@"videoPath"]] options:nil];
  AVAssetTrack *source = [video tracksWithMediaType:AVMediaTypeVideo].firstObject;
  check(source != nil, @"视频文件中没有画面");
  AVMutableCompositionTrack *track = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                                              preferredTrackID:kCMPersistentTrackID_Invalid];
  check([track insertTimeRange:CMTimeRangeMake(kCMTimeZero, duration) ofTrack:source atTime:kCMTimeZero error:&error],
        error.localizedDescription);
  track.preferredTransform = source.preferredTransform;
  for (NSDictionary *segment in options[@"manifest"][@"audio"]) {
    NSString *file = segment[@"file"];
    check([file.lastPathComponent isEqual:file], @"无效录音片段路径");
    NSString *path = [options[@"directory"] stringByAppendingPathComponent:file];
    uint32_t rate = [segment[@"sampleRate"] unsignedIntValue];
    uint16_t channels = [segment[@"channels"] unsignedShortValue];
    check(rate && channels, @"无效录音参数");
    FILE *f = fopen(path.fileSystemRepresentation, "r+b");
    check(f != nullptr, @"缺少恢复录音片段");
    fseek(f, 0, SEEK_END);
    long length = ftell(f);
    check(length >= 44, @"损坏的录音片段");
    uint32_t bytes = (uint32_t)(length - 44);
    bytes -= bytes % (channels * 2);
    wavHeader(f, bytes, rate, channels);
    fclose(f);
    double base = [segment[@"startMs"] doubleValue], lo = MAX(start, base),
           hi = MIN(end, base + bytes * 1000.0 / (rate * channels * 2));
    if (hi <= lo) continue;
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
    AVAssetTrack *audio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
    check(audio != nil, @"无法读取录音片段");
    AVMutableCompositionTrack *destination = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                                                      preferredTrackID:kCMPersistentTrackID_Invalid];
    check([destination insertTimeRange:CMTimeRangeMake(timeMs(lo - base), timeMs(hi - lo))
                               ofTrack:audio
                                atTime:timeMs(lo - start)
                                 error:&error],
          error.localizedDescription);
  }
  // Export explicitly mixes every source/segment into the output audio stream.
  AVMutableAudioMix *mix = [AVMutableAudioMix audioMix];
  NSMutableArray *parameters = [NSMutableArray new];
  for (AVCompositionTrack *audioTrack in [composition tracksWithMediaType:AVMediaTypeAudio]) {
    AVMutableAudioMixInputParameters *input =
        [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:audioTrack];
    [input setVolume:1.0 atTime:kCMTimeZero];
    [parameters addObject:input];
  }
  mix.inputParameters = parameters;
  AVAssetExportSession *exporter = [[AVAssetExportSession alloc] initWithAsset:composition
                                                                    presetName:AVAssetExportPresetHighestQuality];
  check(exporter != nil, @"无法创建 MP4 编码器");
  exporter.outputURL = [NSURL fileURLWithPath:options[@"outputPath"]];
  exporter.outputFileType = AVFileTypeMPEG4;
  exporter.audioMix = mix;
  exporter.timeRange = CMTimeRangeMake(kCMTimeZero, duration);
  exporter.shouldOptimizeForNetworkUse = YES;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [exporter exportAsynchronouslyWithCompletionHandler:^{
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  check(exporter.status == AVAssetExportSessionStatusCompleted, exporter.error.localizedDescription ?: @"MP4 编码失败");
}

static NSString *stringValue(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::vector<char> bytes(length + 1);
  napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length);
  return [NSString stringWithUTF8String:bytes.data()];
}
static napi_value jsString(napi_env env, NSString *value) {
  napi_value result;
  napi_create_string_utf8(env, (value ?: @"").UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}
static NSDictionary *readJSON(napi_env env, napi_value value) {
  napi_value global, json, fn, encoded;
  napi_get_global(env, &global);
  napi_get_named_property(env, global, "JSON", &json);
  napi_get_named_property(env, json, "stringify", &fn);
  napi_call_function(env, json, fn, 1, &value, &encoded);
  return [NSJSONSerialization JSONObjectWithData:[stringValue(env, encoded) dataUsingEncoding:NSUTF8StringEncoding]
                                         options:0
                                           error:nil];
}
static napi_value writeJSON(napi_env env, id value) {
  napi_value global, json, fn, result,
      encoded = jsString(env, [[NSString alloc]
                                  initWithData:[NSJSONSerialization dataWithJSONObject:value
                                                                               options:NSJSONWritingFragmentsAllowed
                                                                                 error:nil]
                                      encoding:NSUTF8StringEncoding]);
  napi_get_global(env, &global);
  napi_get_named_property(env, global, "JSON", &json);
  napi_get_named_property(env, json, "parse", &fn);
  napi_call_function(env, json, fn, 1, &encoded, &result);
  return result;
}
struct Job {
  napi_async_work work;
  napi_deferred deferred;
  NSString *operation;
  NSDictionary *options;
  NSString *sessionId;
  id result;
  NSString *error;
  NSMutableData *pixels;
};
static void run(napi_env, void *opaque) {
  @autoreleasepool {
    Job *j = (Job *)opaque;
    std::unique_lock<std::mutex> deviceLock(deviceMutex, std::defer_lock);
    if ([j->operation isEqual:@"prepare"] || [j->operation isEqual:@"setCamera"] ||
        [j->operation isEqual:@"stop"] || [j->operation isEqual:@"cancel"]) deviceLock.lock();
    @try {
      if ([j->operation isEqual:@"setCamera"]) { setCamera(j->options); return; }
      if ([j->operation isEqual:@"prepare"]) {
        prepare(j->options);
        return;
      }
      if ([j->operation isEqual:@"muxMp4"]) {
        mux(j->options);
        return;
      }
      __block RecordingSession *s;
      __block NSException *exception = nil;
      dispatch_sync(mediaQueue, ^{
        @try {
          s = session;
          check(s && [s.sessionId isEqual:j->sessionId], @"录制媒体会话已失效");
          if (![j->operation isEqual:@"cancel"] && ![j->operation isEqual:@"stop"])
            check(!s.closing && !s.deviceError, s.deviceError ?: @"录制媒体会话已失效");
          double host = hostNow();
          if ([j->operation isEqual:@"begin"]) {
            check(!s.begun, @"录制已经开始");
            s.begun = YES;
            s.active = YES;
            s.hostStart = host;
            j->result = @{@"hostTimeMs" : @(host)};
            [s persist];
          } else if ([j->operation isEqual:@"pause"]) {
            check(s.active, @"录制尚未开始或已经暂停");
            [s closeInterval:host];
            [s persist];
            j->result = @{@"activeTimeMs" : @(s.activeStart)};
          } else if ([j->operation isEqual:@"resume"]) {
            check(s.begun && !s.active, @"录制未暂停");
            s.hostStart = host;
            s.active = YES;
            j->result = @{@"activeTimeMs" : @(s.activeStart)};
            [s persist];
          } else if ([j->operation isEqual:@"snapshot"]) {
            [s persist];
            j->result = [s manifest];
          } else if ([j->operation isEqual:@"stop"] || [j->operation isEqual:@"cancel"]) {
            [s closeInterval:host];
          } else if ([j->operation isEqual:@"composeCamera"]) {
            size_t width = [j->options[@"width"] unsignedLongValue], height = [j->options[@"height"] unsignedLongValue];
            check(width && height && width <= 16384 && height <= 16384 && j->pixels.length == width * height * 4,
                  @"无效画面像素");
            if (s.cameraEnabled) {
              NSDictionary *camera = nil;
              double timestamp = [j->options[@"hostTimeMs"] doubleValue];
              for (NSDictionary *c in s.cameras)
                if ([c[@"host"] doubleValue] <= timestamp) camera = c;
              // A screen frame captured before hot-enable has no camera frame yet.
              if (!camera && s.cameras.count && timestamp < [s.cameras.firstObject[@"host"] doubleValue]) return;
              check(camera != nil, @"摄像头尚未提供同步画面");
              size_t cw = [camera[@"width"] unsignedLongValue], ch = [camera[@"height"] unsignedLongValue];
              size_t dw = MAX(1, MIN(width / 4, height / 3 * cw / ch)), dh = MAX(1, dw * ch / cw),
                     margin = MIN((size_t)16, MIN(width, height) / 20);
              NSString *corner = j->options[@"corner"];
              size_t x = [corner hasSuffix:@"left"] ? margin : width - dw - margin,
                     y = [corner hasPrefix:@"top"] ? margin : height - dh - margin;
              const uint8_t *source = (const uint8_t *)[camera[@"data"] bytes];
              uint8_t *dest = (uint8_t *)j->pixels.mutableBytes;
              for (size_t row = 0; row < dh; row++)
                for (size_t col = 0; col < dw; col++)
                  memcpy(dest + ((y + row) * width + x + col) * 4, source + ((row * ch / dh) * cw + col * cw / dw) * 4,
                         4);
            }
          }
        } @catch (NSException *e) {
          exception = e;
        }
      });
      if (exception) @throw exception;
      if ([j->operation isEqual:@"stop"] || [j->operation isEqual:@"cancel"]) {
        releaseDevices(s);
        dispatch_sync(mediaQueue, ^{
          @try {
            [s persist];
            j->result = [s manifest];
            session = nil;
          } @catch (NSException *e) {
            session = nil;
            exception = e;
          }
        });
        if (exception) @throw exception;
      }
    } @catch (NSException *e) {
      j->error = e.reason;
    }
  }
}
static void complete(napi_env env, napi_status status, void *opaque) {
  Job *j = (Job *)opaque;
  if (j->error || status != napi_ok) {
    napi_value error;
    napi_create_error(env, nullptr, jsString(env, j->error ?: @"录制媒体任务中断"), &error);
    napi_reject_deferred(env, j->deferred, error);
  } else {
    napi_value result;
    if (j->pixels)
      napi_create_buffer_copy(env, j->pixels.length, j->pixels.bytes, nullptr, &result);
    else if (j->result)
      result = writeJSON(env, j->result);
    else
      napi_get_undefined(env, &result);
    napi_resolve_deferred(env, j->deferred, result);
  }
  napi_delete_async_work(env, j->work);
  delete j;
}
static napi_value invoke(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  void *method;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, &method);
  Job *j = new Job();
  j->operation = [NSString stringWithUTF8String:(const char *)method];
  if ([j->operation isEqual:@"composeCamera"]) {
    napi_value buffer;
    napi_get_named_property(env, arg, "bgra", &buffer);
    void *bytes = nullptr;
    size_t length = 0;
    if (napi_get_buffer_info(env, buffer, &bytes, &length) != napi_ok) {
      delete j;
      napi_throw_error(env, nullptr, "Expected BGRA Buffer");
      return nullptr;
    }
    j->pixels = [NSMutableData dataWithBytes:bytes length:length];
    NSMutableDictionary *options = [NSMutableDictionary new];
    for (const char *key : {"sessionId", "corner", "width", "height", "hostTimeMs"}) {
      napi_value v;
      napi_get_named_property(env, arg, key, &v);
      if (strcmp(key, "sessionId") == 0 || strcmp(key, "corner") == 0)
        options[[NSString stringWithUTF8String:key]] = stringValue(env, v);
      else {
        double n = 0;
        napi_get_value_double(env, v, &n);
        options[[NSString stringWithUTF8String:key]] = @(n);
      }
    }
    j->options = options;
    j->sessionId = options[@"sessionId"];
  } else if ([j->operation isEqual:@"prepare"] || [j->operation isEqual:@"muxMp4"] || [j->operation isEqual:@"setCamera"])
    j->options = readJSON(env, arg);
  else
    j->sessionId = stringValue(env, arg);
  if ([j->operation isEqual:@"stop"] || [j->operation isEqual:@"cancel"]) {
    dispatch_sync(mediaQueue, ^{
      if ([session.sessionId isEqual:j->sessionId]) {
        session.closing = YES;
        [session closeInterval:hostNow()];
        dispatch_semaphore_signal(session.readiness);
      }
    });
  }
  napi_value promise;
  napi_create_promise(env, &j->deferred, &promise);
  napi_create_async_work(env, nullptr, jsString(env, j->operation), run, complete, j, &j->work);
  napi_queue_async_work(env, j->work);
  return promise;
}
static napi_value now(napi_env env, napi_callback_info) {
  napi_value value;
  napi_create_double(env, hostNow(), &value);
  return value;
}
static void cleanup(void *) {
  std::lock_guard<std::mutex> deviceLock(deviceMutex);
  RecordingSession *s = session;
  if (s) {
    releaseDevices(s);
    dispatch_sync(mediaQueue, ^{
      @try {
        [s closeInterval:hostNow()];
        [s persist];
      } @catch (NSException *e) {
      }
      session = nil;
    });
  }
}
static napi_value init(napi_env env, napi_value exports) {
  mediaQueue = dispatch_queue_create("local.lasso.recording-media", DISPATCH_QUEUE_SERIAL);
  for (const char *method :
       {"prepare", "setCamera", "begin", "pause", "resume", "composeCamera", "snapshot", "stop", "cancel", "muxMp4"}) {
    napi_value function;
    napi_create_function(env, method, NAPI_AUTO_LENGTH, invoke, (void *)method, &function);
    napi_set_named_property(env, exports, method, function);
  }
  napi_value clock;
  napi_create_function(env, "nowMs", NAPI_AUTO_LENGTH, now, nullptr, &clock);
  napi_set_named_property(env, exports, "nowMs", clock);
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
