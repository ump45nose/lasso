// Generated name table: every icon the app uses, drawn twice (sketch default, lucide optional).
import { Children, cloneElement, isValidElement, useSyncExternalStore, type JSX, type ReactElement } from 'react';
import {
  AlignLeft as LAlignLeft,
  AlignStartVertical as LAlignStartVertical,
  AppWindow as LAppWindow,
  AppWindowMac as LAppWindowMac,
  ArrowDown as LArrowDown,
  ArrowDownToLine as LArrowDownToLine,
  ArrowRight as LArrowRight,
  ArrowUp as LArrowUp,
  ArrowUpRight as LArrowUpRight,
  Barcode as LBarcode,
  BookOpen as LBookOpen,
  Brush as LBrush,
  Camera as LCamera,
  Check as LCheck,
  ChevronDown as LChevronDown,
  ChevronLeft as LChevronLeft,
  ChevronRight as LChevronRight,
  ChevronUp as LChevronUp,
  ChevronsUpDown as LChevronsUpDown,
  Circle as LCircle,
  CircleAlert as LCircleAlert,
  Clipboard as LClipboard,
  ClipboardList as LClipboardList,
  ClipboardPaste as LClipboardPaste,
  CodeXml as LCodeXml,
  Coffee as LCoffee,
  Contrast as LContrast,
  Copy as LCopy,
  CornerDownLeft as LCornerDownLeft,
  Crop as LCrop,
  Download as LDownload,
  Droplets as LDroplets,
  Ellipsis as LEllipsis,
  Eraser as LEraser,
  ExternalLink as LExternalLink,
  Eye as LEye,
  EyeOff as LEyeOff,
  Feather as LFeather,
  File as LFile,
  FileImage as LFileImage,
  FilePlus as LFilePlus,
  FileText as LFileText,
  Flashlight as LFlashlight,
  FlipHorizontal2 as LFlipHorizontal2,
  FlipVertical2 as LFlipVertical2,
  Folder as LFolder,
  FolderGit2 as LFolderGit2,
  FolderOpen as LFolderOpen,
  GitBranch as LGitBranch,
  Grid2X2 as LGrid2X2,
  Grid3x3 as LGrid3x3,
  GripVertical as LGripVertical,
  Hash as LHash,
  Highlighter as LHighlighter,
  Image as LImage,
  ImagePlus as LImagePlus,
  ImageUp as LImageUp,
  KeyRound as LKeyRound,
  Keyboard as LKeyboard,
  Languages as LLanguages,
  LayoutDashboard as LLayoutDashboard,
  Lightbulb as LLightbulb,
  ListChecks as LListChecks,
  ListCollapse as LListCollapse,
  Loader2 as LLoader2,
  Lock as LLock,
  LockOpen as LLockOpen,
  Mail as LMail,
  Maximize2 as LMaximize2,
  MessageCircle as LMessageCircle,
  Minimize2 as LMinimize2,
  Minus as LMinus,
  Monitor as LMonitor,
  MousePointer2 as LMousePointer2,
  MousePointerClick as LMousePointerClick,
  MoveUpRight as LMoveUpRight,
  NotebookPen as LNotebookPen,
  Pause as LPause,
  PenLine as LPenLine,
  Pencil as LPencil,
  Pin as LPin,
  Pipette as LPipette,
  Play as LPlay,
  Plug as LPlug,
  Plus as LPlus,
  Power as LPower,
  Redo2 as LRedo2,
  RefreshCw as LRefreshCw,
  RotateCcw as LRotateCcw,
  RotateCw as LRotateCw,
  Save as LSave,
  Scan as LScan,
  ScanLine as LScanLine,
  ScanText as LScanText,
  Scissors as LScissors,
  Search as LSearch,
  Settings as LSettings,
  Settings2 as LSettings2,
  Sigma as LSigma,
  Slash as LSlash,
  SlidersHorizontal as LSlidersHorizontal,
  Sparkles as LSparkles,
  Square as LSquare,
  SquareDashed as LSquareDashed,
  SquareTerminal as LSquareTerminal,
  Stamp as LStamp,
  Star as LStar,
  Table2 as LTable2,
  TextCursorInput as LTextCursorInput,
  TextSelect as LTextSelect,
  Timer as LTimer,
  Trash2 as LTrash2,
  Type as LType,
  Undo2 as LUndo2,
  Unlock as LUnlock,
  Upload as LUpload,
  Video as LVideo,
  Volume2 as LVolume2,
  VolumeX as LVolumeX,
  X as LX,
  Zap as LZap,
  ZoomIn as LZoomIn,
  type LucideIcon,
  type LucideProps
} from 'lucide-react';
import { ACTION_ICON_IDS, type ActionIconId, type IconStyle } from '../../shared/contracts';
import { actionSketches } from './sketch/actions';
import { contentSketches } from './sketch/content';
import { editorSketches } from './sketch/editor';
import { generalSketches } from './sketch/general';
import './icons.css';

const storageKey = 'lasso.iconStyle';
const read = (): IconStyle => (localStorage.getItem(storageKey) === 'lucide' ? 'lucide' : 'sketch');
let current = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
/** Windows share one origin, so a write here also reaches surfaces that never receive settings (editor, pins). */
window.addEventListener('storage', event => {
  if (event.key !== storageKey) return;
  current = read();
  emit();
});
export function setIconStyle(next: IconStyle) {
  if (next === current) return;
  current = next;
  localStorage.setItem(storageKey, next);
  emit();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useIconStyle = () => useSyncExternalStore(subscribe, () => current);

export type IconProps = LucideProps;
export type IconComponent = ((props: IconProps) => JSX.Element) & { displayName?: string };

/** Strokes get pathLength=1 so `.sk-draw` can trace them in. */
function prepare(body: JSX.Element) {
  return Children.map((body as ReactElement<{ children: JSX.Element[] }>).props.children, child =>
    isValidElement<{ className?: string }>(child) && child.props.className !== 'skf' ? cloneElement(child as ReactElement<Record<string, unknown>>, { pathLength: 1 }) : child
  );
}

function make(name: string, Lucide: LucideIcon, body: JSX.Element): IconComponent {
  const strokes = prepare(body);
  const Icon = ({ size = 24, strokeWidth, absoluteStrokeWidth, color, className, ...rest }: IconProps) => {
    const style = useIconStyle();
    if (style === 'lucide') return <Lucide size={size} strokeWidth={strokeWidth} absoluteStrokeWidth={absoluteStrokeWidth} color={color} className={className} {...rest} />;
    const width = Number(strokeWidth ?? 1.5);
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="1.5 1.5 21 21"
        fill="none"
        stroke={color ?? 'currentColor'}
        strokeWidth={absoluteStrokeWidth ? (width * 21) / Number(size) : width}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={rest['aria-label'] ? undefined : true}
        className={'sk' + (className ? ' ' + className : '')}
        {...rest}
      >
        {strokes}
      </svg>
    );
  };
  Icon.displayName = name;
  return Icon;
}

export const X = make('X', LX, generalSketches.X);
export const Check = make('Check', LCheck, generalSketches.Check);
export const Plus = make('Plus', LPlus, generalSketches.Plus);
export const Minus = make('Minus', LMinus, generalSketches.Minus);
export const ChevronDown = make('ChevronDown', LChevronDown, generalSketches.ChevronDown);
export const ChevronUp = make('ChevronUp', LChevronUp, generalSketches.ChevronUp);
export const ChevronLeft = make('ChevronLeft', LChevronLeft, generalSketches.ChevronLeft);
export const ChevronRight = make('ChevronRight', LChevronRight, generalSketches.ChevronRight);
export const ChevronsUpDown = make('ChevronsUpDown', LChevronsUpDown, generalSketches.ChevronsUpDown);
export const ArrowDown = make('ArrowDown', LArrowDown, generalSketches.ArrowDown);
export const ArrowUp = make('ArrowUp', LArrowUp, generalSketches.ArrowUp);
export const ArrowRight = make('ArrowRight', LArrowRight, generalSketches.ArrowRight);
export const ArrowUpRight = make('ArrowUpRight', LArrowUpRight, generalSketches.ArrowUpRight);
export const ArrowDownToLine = make('ArrowDownToLine', LArrowDownToLine, generalSketches.ArrowDownToLine);
export const MoveUpRight = make('MoveUpRight', LMoveUpRight, generalSketches.MoveUpRight);
export const CornerDownLeft = make('CornerDownLeft', LCornerDownLeft, generalSketches.CornerDownLeft);
export const Ellipsis = make('Ellipsis', LEllipsis, generalSketches.Ellipsis);
export const GripVertical = make('GripVertical', LGripVertical, generalSketches.GripVertical);
export const Search = make('Search', LSearch, generalSketches.Search);
export const Settings = make('Settings', LSettings, generalSketches.Settings);
export const Settings2 = make('Settings2', LSettings2, generalSketches.Settings2);
export const SlidersHorizontal = make('SlidersHorizontal', LSlidersHorizontal, generalSketches.SlidersHorizontal);
export const Maximize2 = make('Maximize2', LMaximize2, generalSketches.Maximize2);
export const Minimize2 = make('Minimize2', LMinimize2, generalSketches.Minimize2);
export const ExternalLink = make('ExternalLink', LExternalLink, generalSketches.ExternalLink);
export const RefreshCw = make('RefreshCw', LRefreshCw, generalSketches.RefreshCw);
export const RotateCcw = make('RotateCcw', LRotateCcw, generalSketches.RotateCcw);
export const RotateCw = make('RotateCw', LRotateCw, generalSketches.RotateCw);
export const Undo2 = make('Undo2', LUndo2, generalSketches.Undo2);
export const Redo2 = make('Redo2', LRedo2, generalSketches.Redo2);
export const Trash2 = make('Trash2', LTrash2, generalSketches.Trash2);
export const Copy = make('Copy', LCopy, generalSketches.Copy);
export const Download = make('Download', LDownload, generalSketches.Download);
export const Upload = make('Upload', LUpload, generalSketches.Upload);
export const Save = make('Save', LSave, generalSketches.Save);
export const Lock = make('Lock', LLock, generalSketches.Lock);
export const LockOpen = make('LockOpen', LLockOpen, generalSketches.LockOpen);
export const Unlock = make('Unlock', LUnlock, generalSketches.Unlock);
export const Eye = make('Eye', LEye, generalSketches.Eye);
export const EyeOff = make('EyeOff', LEyeOff, generalSketches.EyeOff);
export const CircleAlert = make('CircleAlert', LCircleAlert, generalSketches.CircleAlert);
export const Loader2 = make('Loader2', LLoader2, generalSketches.Loader2);
export const Power = make('Power', LPower, generalSketches.Power);
export const File = make('File', LFile, contentSketches.File);
export const FileText = make('FileText', LFileText, contentSketches.FileText);
export const FileImage = make('FileImage', LFileImage, contentSketches.FileImage);
export const FilePlus = make('FilePlus', LFilePlus, contentSketches.FilePlus);
export const Folder = make('Folder', LFolder, contentSketches.Folder);
export const FolderOpen = make('FolderOpen', LFolderOpen, contentSketches.FolderOpen);
export const FolderGit2 = make('FolderGit2', LFolderGit2, contentSketches.FolderGit2);
export const GitBranch = make('GitBranch', LGitBranch, contentSketches.GitBranch);
export const CodeXml = make('CodeXml', LCodeXml, contentSketches.CodeXml);
export const SquareTerminal = make('SquareTerminal', LSquareTerminal, contentSketches.SquareTerminal);
export const Monitor = make('Monitor', LMonitor, contentSketches.Monitor);
export const AppWindow = make('AppWindow', LAppWindow, contentSketches.AppWindow);
export const AppWindowMac = make('AppWindowMac', LAppWindowMac, contentSketches.AppWindowMac);
export const LayoutDashboard = make('LayoutDashboard', LLayoutDashboard, contentSketches.LayoutDashboard);
export const Clipboard = make('Clipboard', LClipboard, contentSketches.Clipboard);
export const ClipboardList = make('ClipboardList', LClipboardList, contentSketches.ClipboardList);
export const ClipboardPaste = make('ClipboardPaste', LClipboardPaste, contentSketches.ClipboardPaste);
export const ListChecks = make('ListChecks', LListChecks, contentSketches.ListChecks);
export const NotebookPen = make('NotebookPen', LNotebookPen, contentSketches.NotebookPen);
export const Languages = make('Languages', LLanguages, contentSketches.Languages);
export const Sparkles = make('Sparkles', LSparkles, contentSketches.Sparkles);
export const Image = make('Image', LImage, contentSketches.Image);
export const ImagePlus = make('ImagePlus', LImagePlus, contentSketches.ImagePlus);
export const Camera = make('Camera', LCamera, contentSketches.Camera);
export const Video = make('Video', LVideo, contentSketches.Video);
export const Play = make('Play', LPlay, contentSketches.Play);
export const Pause = make('Pause', LPause, contentSketches.Pause);
export const Square = make('Square', LSquare, contentSketches.Square);
export const Circle = make('Circle', LCircle, contentSketches.Circle);
export const Timer = make('Timer', LTimer, contentSketches.Timer);
export const Coffee = make('Coffee', LCoffee, contentSketches.Coffee);
export const Volume2 = make('Volume2', LVolume2, contentSketches.Volume2);
export const VolumeX = make('VolumeX', LVolumeX, contentSketches.VolumeX);
export const TextCursorInput = make('TextCursorInput', LTextCursorInput, contentSketches.TextCursorInput);
export const Star = make('Star', LStar, contentSketches.Star);
export const Keyboard = make('Keyboard', LKeyboard, contentSketches.Keyboard);
export const Zap = make('Zap', LZap, contentSketches.Zap);
export const Plug = make('Plug', LPlug, contentSketches.Plug);
export const KeyRound = make('KeyRound', LKeyRound, contentSketches.KeyRound);
export const Pin = make('Pin', LPin, contentSketches.Pin);
export const Crop = make('Crop', LCrop, editorSketches.Crop);
export const Scan = make('Scan', LScan, editorSketches.Scan);
export const ScanLine = make('ScanLine', LScanLine, editorSketches.ScanLine);
export const ScanText = make('ScanText', LScanText, editorSketches.ScanText);
export const SquareDashed = make('SquareDashed', LSquareDashed, editorSketches.SquareDashed);
export const TextSelect = make('TextSelect', LTextSelect, editorSketches.TextSelect);
export const Type = make('Type', LType, editorSketches.Type);
export const AlignLeft = make('AlignLeft', LAlignLeft, editorSketches.AlignLeft);
export const AlignStartVertical = make('AlignStartVertical', LAlignStartVertical, editorSketches.AlignStartVertical);
export const Highlighter = make('Highlighter', LHighlighter, editorSketches.Highlighter);
export const PenLine = make('PenLine', LPenLine, editorSketches.PenLine);
export const Pencil = make('Pencil', LPencil, editorSketches.Pencil);
export const Eraser = make('Eraser', LEraser, editorSketches.Eraser);
export const Pipette = make('Pipette', LPipette, editorSketches.Pipette);
export const Droplets = make('Droplets', LDroplets, editorSketches.Droplets);
export const Contrast = make('Contrast', LContrast, editorSketches.Contrast);
export const Flashlight = make('Flashlight', LFlashlight, editorSketches.Flashlight);
export const FlipHorizontal2 = make('FlipHorizontal2', LFlipHorizontal2, editorSketches.FlipHorizontal2);
export const FlipVertical2 = make('FlipVertical2', LFlipVertical2, editorSketches.FlipVertical2);
export const Grid2X2 = make('Grid2X2', LGrid2X2, editorSketches.Grid2X2);
export const Grid3x3 = make('Grid3x3', LGrid3x3, editorSketches.Grid3x3);
export const Hash = make('Hash', LHash, editorSketches.Hash);
export const Sigma = make('Sigma', LSigma, editorSketches.Sigma);
export const Slash = make('Slash', LSlash, editorSketches.Slash);
export const Stamp = make('Stamp', LStamp, editorSketches.Stamp);
export const Table2 = make('Table2', LTable2, editorSketches.Table2);
export const Barcode = make('Barcode', LBarcode, editorSketches.Barcode);
export const ZoomIn = make('ZoomIn', LZoomIn, editorSketches.ZoomIn);
export const MousePointer2 = make('MousePointer2', LMousePointer2, editorSketches.MousePointer2);
export const MousePointerClick = make('MousePointerClick', LMousePointerClick, editorSketches.MousePointerClick);
export const Scissors = make('Scissors', LScissors, editorSketches.Scissors);

const actionLucide: Record<ActionIconId, LucideIcon> = {
  'ask': LMessageCircle,
  'book': LBookOpen,
  'sum': LListCollapse,
  'translate': LLanguages,
  'note': LNotebookPen,
  'todo': LListChecks,
  'brush': LBrush,
  'image': LImage,
  'image-edit': LImageUp,
  'quill': LFeather,
  'code': LCodeXml,
  'terminal': LSquareTerminal,
  'search': LSearch,
  'mail': LMail,
  'bulb': LLightbulb,
  'spark': LSparkles
};
export const actionIconLabels: Record<ActionIconId, string> = {
  'ask': '对话',
  'book': '释义',
  'sum': '提炼',
  'translate': '翻译',
  'note': '便签',
  'todo': '待办',
  'brush': '画笔',
  'image': '配图',
  'image-edit': '改图',
  'quill': '润色',
  'code': '代码',
  'terminal': '终端',
  'search': '搜索',
  'mail': '邮件',
  'bulb': '灵感',
  'spark': '灵光'
};
const actionIcons = Object.fromEntries(ACTION_ICON_IDS.map(id => [id, make('Action:' + id, actionLucide[id], actionSketches[id])])) as Record<ActionIconId, IconComponent>;
export function ActionIcon({ id, ...props }: IconProps & { id: ActionIconId }) {
  const Icon = actionIcons[id] ?? actionIcons.spark;
  return <Icon {...props} />;
}
