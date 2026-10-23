import type { AgentEvent, AgentState } from '../shared/contracts';

/** Preserve unchanged message references so completed Markdown never re-renders per token. */
export function mergeAgentEvent(state: AgentState, event: AgentEvent): AgentState {
  if (event.taskId !== state.taskId || event.revision <= state.revision) return state;
  let messages = state.messages;
  if (event.messages.length || event.order) {
    const byId = new Map(messages.map(message => [message.id, message]));
    for (const message of event.messages) byId.set(message.id, message);
    messages = event.order ? event.order.map(id => byId.get(id)!).filter(Boolean) : messages.map(message => byId.get(message.id)!);
  }
  return { ...state, ...event.patch, revision: event.revision, messages };
}
