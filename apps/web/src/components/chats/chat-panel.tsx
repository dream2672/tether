import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '@tether/design';
import { useAuth } from '../../hooks/use-auth.js';
import { useI18n } from '../../hooks/use-i18n.js';
import { rememberGatewayVersion } from '../../hooks/use-update-check.js';
import { getStoredNormalAccessToken } from '../../lib/api.js';
import { providerResumeCommand } from '../../lib/provider-resume-command.js';
import { fetchChatEventsAfter, fetchChatMessages, fetchChatSessions, type ChatRuntimeEventResponse, type ChatSessionRecord, type ProviderOption } from './data/chat-data.js';
import { applyChatStreamEvent, applyChatStreamEvents, historySnapshotToReducerState, type ChatStreamEvent } from './events/chat-event-reducer.js';
import { mapRelayFrameToChatEvent, mapStructuredCatchupResponse } from './events/chat-event-mappers.js';
import { createClientRequestId, createOptimisticTurn } from './flow/chat-create-flow.js';
import { bufferLiveEvent, createRestoreBuffer, drainBufferedEvents, type ChatRestoreBuffer } from './flow/chat-restore-buffer.js';
import { shouldApplyGatewayUnavailable } from './flow/chat-session-guards.js';
import { shouldClearSessionViewState } from './flow/session-switch-guards.js';
import { ChatHeader } from './shell/chat-header.js';
import { ChatComposer } from './composer/chat-composer.js';
import { ChatMessageList } from './shell/chat-message-list.js';
import { NewChatSurface } from './shell/new-chat-surface.js';
import { type RelayFrame, useRelayClient } from '../relay/use-relay-client.js';
import { ComposerSubmitButton } from '../workbench/composer-submit-button.js';
import { PathPicker } from '../workbench/path-picker.js';
import { WorkbenchCompactConnectionStatus } from '../workbench/workbench-status-pill.js';
import { GatewaySelector } from './shell/gateway-selector.js';
import { SlashCommandMenu } from './composer/slash-command-menu.js';
import { useSlashMenu } from './composer/use-slash-menu.js';
import type { HistoryUsage, MessageItem, UsageStats } from './model/chat-types.js';
import {
  compactProjectPath,
  findLastAgentIndex,
  isProviderOption,
  usageStatsFromHistory
} from './model/chat-utils.js';

const DEFAULT_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: 'claude', models: ['sonnet', 'opus', 'haiku'] }
];
const RECENT_CWD_LIMIT = 2;
const RESTORE_BUFFER_MAX_EVENTS = 1000;
const RESTORE_BUFFER_MAX_PAYLOAD_BYTES = 1024 * 1024;

function recentCwdKey(gatewayId: string, provider: string): string {
  return `tether.recentCwds.v1.${gatewayId}.${provider}`;
}

function errorAgentId(frame: RelayFrame, fallbackClientRequestId: string | null): string | undefined {
  const clientRequestId = typeof frame.clientRequestId === 'string' && frame.clientRequestId.trim()
    ? frame.clientRequestId
    : fallbackClientRequestId;
  return clientRequestId ? `agent-${clientRequestId}` : undefined;
}

function readRecentCwds(gatewayId?: string, provider?: string): string[] {
  if (!gatewayId || !provider) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(recentCwdKey(gatewayId, provider)) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, RECENT_CWD_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function rememberRecentCwd(gatewayId: string | undefined, provider: string | undefined, cwd: string): string[] {
  const normalized = cwd.trim();
  if (!gatewayId || !provider || !normalized) return [];
  const next = [normalized, ...readRecentCwds(gatewayId, provider).filter((item) => item !== normalized)].slice(0, RECENT_CWD_LIMIT);
  window.localStorage.setItem(recentCwdKey(gatewayId, provider), JSON.stringify(next));
  return next;
}

function formatResetCountdown(resetsAt: number): string {
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return '刷新中';
  const totalMin = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function UsageStatsChip({ contextPct, rateLimitResetsAt, rateLimitType }: { contextPct?: number; rateLimitResetsAt?: number; rateLimitType?: string }) {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!rateLimitResetsAt) return;
    const id = window.setInterval(() => forceUpdate(), 60000);
    return () => window.clearInterval(id);
  }, [rateLimitResetsAt]);

  const parts: string[] = [];
  if (contextPct !== undefined) parts.push(`ctx ${contextPct}%`);
  if (rateLimitResetsAt) {
    const label = rateLimitType === 'five_hour' ? '5h' : rateLimitType ?? 'limit';
    parts.push(`${label} resets ${formatResetCountdown(rateLimitResetsAt)}`);
  }
  if (parts.length === 0) return null;

  return (
    <span className="flex h-7 items-center rounded-full bg-muted px-3 font-mono text-[11px] text-muted-foreground/70 tabular-nums">
      {parts.join(' · ')}
    </span>
  );
}

export function ChatPanel({
  activeSessionId,
  onExpandSidebar,
  onOpenDrawer,
  onReconnectCatchup
}: {
  activeSessionId?: string;
  onExpandSidebar?: () => void;
  onOpenDrawer?: () => void;
  onReconnectCatchup?: () => void;
}) {
  const navigate = useNavigate();
  const { normalAuth } = useAuth();
  const { t } = useI18n();
  const [messages, setMessages] = React.useState<MessageItem[]>([]);
  const [inputText, setInputText] = React.useState('');
  const [isInflight, setIsInflight] = React.useState(false);
  const [currentSessionId, setCurrentSessionId] = React.useState<string | undefined>(activeSessionId);
  const [providerOptions, setProviderOptions] = React.useState<ProviderOption[]>(DEFAULT_PROVIDER_OPTIONS);
  const [selectedProvider, setSelectedProvider] = React.useState(DEFAULT_PROVIDER_OPTIONS[0]!.provider);
  const [selectedModel, setSelectedModel] = React.useState(DEFAULT_PROVIDER_OPTIONS[0]!.models[0]!);
  const [activeSessionProvider, setActiveSessionProvider] = React.useState<string | undefined>(undefined);
  const [activeSessionModel, setActiveSessionModel] = React.useState<string | undefined>(undefined);
  const [activeSessionProjectPath, setActiveSessionProjectPath] = React.useState<string | undefined>(undefined);
  const [activeSessionGatewayId, setActiveSessionGatewayId] = React.useState<string | undefined>(undefined);
  const [activeSessionMetadataReady, setActiveSessionMetadataReady] = React.useState(!activeSessionId);
  const [selectedGatewayId, setSelectedGatewayId] = React.useState<string | undefined>(undefined);
  const [selectedGatewayName, setSelectedGatewayName] = React.useState<string | undefined>(undefined);
  const [subscribeRetryKey, setSubscribeRetryKey] = React.useState(0);
  const [cwd, setCwd] = React.useState('~');
  const [cwdSuggestions, setCwdSuggestions] = React.useState<string[]>([]);
  const [recentCwdSuggestions, setRecentCwdSuggestions] = React.useState<string[]>([]);
  const [cwdSuggestionsLoading, setCwdSuggestionsLoading] = React.useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = React.useState(false);
  const [cwdActiveIndex, setCwdActiveIndex] = React.useState(0);
  const [agentSessionId, setAgentSessionId] = React.useState<string | undefined>(undefined);
  const [connectionError, setConnectionError] = React.useState<string | undefined>(undefined);
  const [sessionAccessError, setSessionAccessError] = React.useState<string | undefined>(undefined);
  const [restoreError, setRestoreError] = React.useState<string | undefined>(undefined);
  const [isRestoring, setIsRestoring] = React.useState(false);
  const hasEverConnectedRef = React.useRef(false);
  const [usageStats, setUsageStats] = React.useState<UsageStats | undefined>(undefined);
  const [copiedAgentId, setCopiedAgentId] = React.useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = React.useState(false);
  const messageScrollRef = React.useRef<HTMLDivElement | null>(null);
  const messageEndRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const newSessionInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pendingClientRequestIdRef = React.useRef<string | null>(null);
  const inflightStartedAtRef = React.useRef<number>(0);
  const revealTimerRef = React.useRef<number | undefined>(undefined);
  const messagesRef = React.useRef<MessageItem[]>([]);
  const activeSessionProviderRef = React.useRef(activeSessionProvider);
  const selectedProviderRef = React.useRef(selectedProvider);
  const currentSessionIdRef = React.useRef(currentSessionId);
  const selectedGatewayIdRef = React.useRef(selectedGatewayId);
  const activeSessionGatewayIdRef = React.useRef(activeSessionGatewayId);
  const subscribedSessionIdRef = React.useRef<string | null>(null);
  const releaseSessionSubscriptionRef = React.useRef<(() => void) | null>(null);
  const cwdRef = React.useRef(cwd);
  const skipNextHistoryLoadSessionIdRef = React.useRef<string | null>(null);
  const pendingCreatedSessionIdRef = React.useRef<string | null>(null);
  const pendingSessionProviderRef = React.useRef<string | undefined>(undefined);
  const pendingSessionModelRef = React.useRef<string | undefined>(undefined);
  const createdSessionIdRef = React.useRef<string | null>(null);
  const lastCatchupConnectionEpochRef = React.useRef(0);
  const previousSelectedGatewayIdRef = React.useRef<string | undefined>(undefined);
  const providerRequestKeyRef = React.useRef<string | undefined>(undefined);
  const isComposingRef = React.useRef(false);
  const lastAppliedEventSeqRef = React.useRef(0);
  const lastSubscriptionAckKeyRef = React.useRef<string | null>(null);
  const restoreBufferRef = React.useRef<ChatRestoreBuffer | null>(null);
  const restoreAttemptIdRef = React.useRef<string | null>(null);
  const restoreAttemptSeqRef = React.useRef(0);

  const relay = useRelayClient();
  const {
    acquireSessionSubscription,
    connectionEpoch,
    defaultGatewayId,
    gatewayConnected,
    gatewayIdsOnline,
    gatewayNamesById,
    relaySessions: providerRelaySessions,
    sendFrame,
    subscribeClose,
    subscribeFrame,
    wsReady
  } = relay;

  const applyStructuredEvent = React.useCallback((event: ChatStreamEvent) => {
    setMessages((items) => {
      const nextState = applyChatStreamEvent(
        {
          completedTurnIds: new Set(
            items
              .filter((item): item is Extract<MessageItem, { kind: 'agent' }> => item.kind === 'agent' && !item.isStreaming && !item.isWaiting)
              .map((item) => item.id)
          ),
          lastEventSeq: lastAppliedEventSeqRef.current,
          messages: items
        },
        event
      );
      lastAppliedEventSeqRef.current = nextState.lastEventSeq;
      return nextState.messages;
    });
  }, []);

  const handleStructuredEvent = React.useCallback((sessionId: string, event: ChatStreamEvent) => {
    const buffer = restoreBufferRef.current;
    if (buffer?.sessionId === sessionId && buffer.status === 'open') {
      const next = bufferLiveEvent({
        buffer,
        event,
        maxEvents: RESTORE_BUFFER_MAX_EVENTS,
        maxPayloadBytes: RESTORE_BUFFER_MAX_PAYLOAD_BYTES
      });
      restoreBufferRef.current = next.buffer;
      if (!next.rejectedEvent) {
        return;
      }
      applyStructuredEvent(next.rejectedEvent);
      return;
    }
    applyStructuredEvent(event);
  }, [applyStructuredEvent]);

  React.useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  React.useEffect(() => {
    activeSessionProviderRef.current = activeSessionProvider;
  }, [activeSessionProvider]);

  React.useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

  React.useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  React.useEffect(() => {
    selectedGatewayIdRef.current = selectedGatewayId;
  }, [selectedGatewayId]);

  React.useEffect(() => {
    activeSessionGatewayIdRef.current = activeSessionGatewayId;
  }, [activeSessionGatewayId]);

  const scrollMessagesToBottom = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    window.requestAnimationFrame(() => {
      messageEndRef.current?.scrollIntoView({ block: 'end', behavior });
    });
  }, []);

  React.useEffect(() => {
    if (currentSessionId) {
      scrollMessagesToBottom('auto');
    }
  }, [currentSessionId, scrollMessagesToBottom]);

  React.useEffect(() => {
    if (messages.length > 0) {
      scrollMessagesToBottom(messages.some((message) => message.kind === 'agent' && message.isStreaming) ? 'auto' : 'smooth');
    }
  }, [messages, scrollMessagesToBottom]);

  React.useEffect(() => {
    if (connectionError || sessionAccessError) {
      scrollMessagesToBottom('smooth');
    }
  }, [connectionError, scrollMessagesToBottom, sessionAccessError]);

  React.useEffect(() => {
    return () => {
      if (revealTimerRef.current !== undefined) {
        window.clearInterval(revealTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (revealTimerRef.current !== undefined) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = undefined;
    }
    setSessionAccessError(undefined);
    setRestoreError(undefined);
    setIsRestoring(Boolean(activeSessionId));
    restoreAttemptIdRef.current = activeSessionId
      ? `restore-${activeSessionId}-${++restoreAttemptSeqRef.current}`
      : null;
    currentSessionIdRef.current = activeSessionId;
    setCurrentSessionId(activeSessionId);
    setAgentSessionId(undefined);
    setActiveSessionProjectPath(undefined);
    setActiveSessionGatewayId(undefined);
    setActiveSessionMetadataReady(!activeSessionId);
    if (activeSessionId && activeSessionId === createdSessionIdRef.current) {
      setActiveSessionProvider(pendingSessionProviderRef.current);
      setActiveSessionModel(pendingSessionModelRef.current);
      setActiveSessionGatewayId(selectedGatewayId);
      setActiveSessionMetadataReady(true);
      setIsRestoring(false);
      createdSessionIdRef.current = null;
    } else {
      setActiveSessionProvider(undefined);
      setActiveSessionModel(undefined);
    }
  }, [activeSessionId]);

  const loadActiveSessionHistory = React.useCallback(async (sessionId: string, opts?: { protectNewerLocal?: boolean; restoreAttemptId?: string }) => {
    const token = normalAuth?.accessToken ?? getStoredNormalAccessToken();
    const { messages: historyMessages, snapshotEventSeq } = await fetchChatMessages(sessionId, token);
    if (
      sessionId !== currentSessionIdRef.current ||
      (opts?.restoreAttemptId && opts.restoreAttemptId !== restoreAttemptIdRef.current)
    ) {
      return false;
    }
    const reducerState = historySnapshotToReducerState(historyMessages, activeSessionProviderRef.current ?? 'agent', snapshotEventSeq);
    const catchupEvents = mapStructuredCatchupResponse({
      events: await fetchChatEventsAfter(sessionId, snapshotEventSeq, token),
      provider: activeSessionProviderRef.current ?? 'agent',
      sessionId
    });
    if (
      sessionId !== currentSessionIdRef.current ||
      (opts?.restoreAttemptId && opts.restoreAttemptId !== restoreAttemptIdRef.current)
    ) {
      return false;
    }
    const buffer = restoreBufferRef.current;
    const drained = buffer?.sessionId === sessionId
      ? drainBufferedEvents({ buffer, catchupEvents, snapshotEventSeq })
      : undefined;
    if (drained) {
      restoreBufferRef.current = drained.buffer;
    }
    const shouldKeepPendingOptimistic =
      opts?.protectNewerLocal &&
      historyMessages.length === 0 &&
      catchupEvents.length === 0 &&
      messagesRef.current.some((item) => item.kind === 'agent' && item.isWaiting && item.id.startsWith('agent-'));
    if (shouldKeepPendingOptimistic) {
      lastAppliedEventSeqRef.current = Math.max(lastAppliedEventSeqRef.current, snapshotEventSeq);
      return true;
    }
    const items = reducerState.messages;
    let nextIsInflight = false;
    const lastItem = items.at(-1);
    if (lastItem?.kind === 'agent' && lastItem.isWaiting) {
      nextIsInflight = true;
    }
    const nextState = applyChatStreamEvents(reducerState, drained?.eventsToApply ?? catchupEvents);
    lastAppliedEventSeqRef.current = nextState.lastEventSeq;
    setIsInflight(nextIsInflight || nextState.messages.some((item) => item.kind === 'agent' && (item.isWaiting || item.isStreaming)));
    setUsageStats(usageStatsFromHistory(historyMessages));
    setMessages(nextState.messages);
    return true;
  }, [normalAuth?.accessToken]);

  const loadActiveSessionMetadata = React.useCallback(async (sessionId: string, opts?: { restoreAttemptId?: string }) => {
    const token = normalAuth?.accessToken ?? getStoredNormalAccessToken();
    if (!token) {
      return false;
    }
    const sessions = await fetchChatSessions(token);
    if (
      sessionId !== currentSessionIdRef.current ||
      (opts?.restoreAttemptId && opts.restoreAttemptId !== restoreAttemptIdRef.current)
    ) {
      return false;
    }
    const session = sessions.find((item) => item.id === sessionId);
    setAgentSessionId(session?.agentSessionId);
    setActiveSessionProvider(session?.provider);
    setActiveSessionProjectPath(session?.projectPath);
    setActiveSessionGatewayId(session?.gatewayId);
    setActiveSessionModel(undefined);
    setActiveSessionMetadataReady(true);
    return true;
  }, [normalAuth?.accessToken]);

  React.useEffect(() => {
    if (!currentSessionId) {
      return;
    }
    const session = providerRelaySessions.find((item) => item.id === currentSessionId);
    if (!session) {
      return;
    }
    if (session.gatewayId) {
      setActiveSessionGatewayId(session.gatewayId);
      setSelectedGatewayId(session.gatewayId);
    }
    if (session.provider) {
      setActiveSessionProvider(session.provider);
    }
    if (session.projectPath) {
      setActiveSessionProjectPath(session.projectPath);
    }
    if (session.agentSessionId) {
      setAgentSessionId(session.agentSessionId);
    }
    setActiveSessionMetadataReady(true);
  }, [currentSessionId, providerRelaySessions]);

  React.useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setUsageStats(undefined);
      setIsInflight(false);
      setRestoreError(undefined);
      setIsRestoring(false);
      setAgentSessionId(undefined);
      setActiveSessionProjectPath(undefined);
      setActiveSessionGatewayId(undefined);
      setActiveSessionMetadataReady(true);
      return;
    }
    lastSubscriptionAckKeyRef.current = null;
    const restoreAttemptId = restoreAttemptIdRef.current ?? `restore-${activeSessionId}-${++restoreAttemptSeqRef.current}`;
    restoreAttemptIdRef.current = restoreAttemptId;
    if (
      skipNextHistoryLoadSessionIdRef.current === activeSessionId ||
      pendingCreatedSessionIdRef.current === activeSessionId
    ) {
      skipNextHistoryLoadSessionIdRef.current = null;
      return;
    }
    if (shouldClearSessionViewState({
      activeSessionId,
      pendingCreatedSessionId: pendingCreatedSessionIdRef.current,
      skipNextHistoryLoadSessionId: skipNextHistoryLoadSessionIdRef.current
    })) {
      setMessages([]);
      setUsageStats(undefined);
      setIsInflight(false);
      lastAppliedEventSeqRef.current = 0;
      restoreBufferRef.current = null;
    }
    setIsRestoring(true);
    void loadActiveSessionHistory(activeSessionId, { restoreAttemptId })
      .then((applied) => {
        if (!applied || restoreAttemptIdRef.current !== restoreAttemptId) return;
        setRestoreError(undefined);
      })
      .catch(() => {
        if (restoreAttemptIdRef.current !== restoreAttemptId || currentSessionIdRef.current !== activeSessionId) return;
        restoreBufferRef.current = null;
        setRestoreError(t.chatsHistoryFail);
        setMessages((items) => [
          ...items,
          { kind: 'system', id: `history-error-${Date.now()}`, text: t.chatsHistoryFail }
        ]);
      })
      .finally(() => {
        if (restoreAttemptIdRef.current === restoreAttemptId) {
          setIsRestoring(false);
        }
      });
  }, [activeSessionId, loadActiveSessionHistory, t.chatsHistoryFail]);

  React.useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const restoreAttemptId = restoreAttemptIdRef.current ?? undefined;
    void loadActiveSessionMetadata(activeSessionId, { restoreAttemptId }).catch(() => {
      if (currentSessionIdRef.current === activeSessionId && restoreAttemptIdRef.current === restoreAttemptId) {
        setActiveSessionMetadataReady(true);
      }
    });
  }, [activeSessionId, loadActiveSessionMetadata]);

  const handleRelayClose = React.useCallback(() => {
    subscribedSessionIdRef.current = null;
    setConnectionError(t.gatewayNotConnected);
    setIsInflight(false);
    pendingClientRequestIdRef.current = null;
  }, [t.gatewayNotConnected]);

  const clearGatewayNotConnectedError = React.useCallback(() => {
    setConnectionError((current) => current === t.gatewayNotConnected ? undefined : current);
  }, [t.gatewayNotConnected]);

  const handleRelayFrame = React.useCallback((frame: RelayFrame, relay: { sendFrame: (frame: Record<string, unknown>) => boolean }) => {
      if (frame.type === 'client.auth.ok') {
        hasEverConnectedRef.current = true;
        setConnectionError(undefined);
        return;
      }
      if (frame.type === 'hello') {
        const gatewayId = typeof frame.gatewayId === 'string' ? frame.gatewayId : undefined;
        if (gatewayId) {
          setSelectedGatewayId((current) => current ?? gatewayId);
          clearGatewayNotConnectedError();
        }
        return;
      }
      if (frame.type === 'gateway.status' && typeof frame.gatewayId === 'string') {
        const gatewayId = frame.gatewayId;
        if (typeof frame.version === 'string' && frame.version) {
          rememberGatewayVersion(gatewayId, frame.version);
        }
        if (frame.status === 'connected') {
          setSelectedGatewayId((current) => current ?? gatewayId);
          clearGatewayNotConnectedError();
          relay.sendFrame({ type: 'client.list-providers', gatewayId });
          return;
        }
        if (frame.status === 'disconnected') {
          const effectiveGatewayId = currentSessionIdRef.current
            ? (activeSessionGatewayIdRef.current ?? selectedGatewayIdRef.current)
            : selectedGatewayIdRef.current;
          if (gatewayId === effectiveGatewayId) {
            subscribedSessionIdRef.current = null;
            setConnectionError(t.gatewayNotConnected);
          }
          return;
        }
      }
      if (frame.type === 'sessions' && Array.isArray(frame.sessions)) {
        const pendingId = currentSessionIdRef.current;
        if (pendingId && subscribedSessionIdRef.current == null) {
          const appeared = (frame.sessions as unknown[]).some((s) => typeof s === 'object' && s !== null && (s as Record<string, unknown>).id === pendingId);
          if (appeared) {
            setSubscribeRetryKey((k) => k + 1);
          }
        }
        return;
      }
      if (frame.type === 'gateway.providers') {
        const frameGatewayId = typeof frame.gatewayId === 'string' ? frame.gatewayId : undefined;
        if (frameGatewayId && frameGatewayId !== selectedGatewayId) {
          return;
        }
        const nextProviders = Array.isArray(frame.providers)
          ? frame.providers.filter((provider: unknown): provider is ProviderOption => isProviderOption(provider))
          : [];
        if (nextProviders.length > 0) {
          clearGatewayNotConnectedError();
          setProviderOptions(nextProviders);
          setSelectedProvider((currentProvider) =>
            nextProviders.some((provider: ProviderOption) => provider.provider === currentProvider)
              ? currentProvider
              : nextProviders[0]!.provider
          );
          setSelectedModel((currentModel) => {
            const provider =
              nextProviders.find((item: ProviderOption) => item.provider === selectedProviderRef.current) ??
              nextProviders[0]!;
            return provider.models.includes(currentModel) ? currentModel : provider.models[0]!;
          });
        } else {
          setMessages((items) => [...items, { kind: 'system', id: `providers-${Date.now()}`, text: t.chatsProviderFail }]);
        }
        return;
      }
      if (frame.type === 'gateway.cwd-suggestions') {
        const frameGatewayId = typeof frame.gatewayId === 'string' ? frame.gatewayId : undefined;
        if (
          typeof frame.cwd === 'string' &&
          frame.cwd === cwdRef.current &&
          (!frameGatewayId || frameGatewayId === selectedGatewayId)
        ) {
          const suggestions = Array.isArray(frame.suggestions)
            ? frame.suggestions.filter((item: unknown): item is string => typeof item === 'string')
            : [];
          setCwdSuggestions(suggestions);
          setCwdSuggestionsLoading(false);
          setCwdActiveIndex(0);
        }
        return;
      }
      if (frame.type === 'gateway.session-created' && typeof frame.sessionId === 'string') {
        setConnectionError(undefined);
        setSessionAccessError(undefined);
        setActiveSessionGatewayId(selectedGatewayId);
        setActiveSessionMetadataReady(true);
        skipNextHistoryLoadSessionIdRef.current = frame.sessionId;
        pendingCreatedSessionIdRef.current = frame.sessionId;
        createdSessionIdRef.current = frame.sessionId;
        setAgentSessionId(undefined);
        setActiveSessionProvider(pendingSessionProviderRef.current);
        setActiveSessionModel(pendingSessionModelRef.current);
        currentSessionIdRef.current = frame.sessionId;
        setCurrentSessionId(frame.sessionId);
        navigate(`/chats/${frame.sessionId}`, { replace: true });
        setMessages((items) => [...items, { kind: 'system', id: `started-${frame.sessionId}`, text: t.chatsSessionStarted }]);
        return;
      }
      if (frame.type === 'subscription.ack' && typeof frame.sessionId === 'string') {
        if (frame.sessionId !== currentSessionIdRef.current) {
          return;
        }
        const ackKey = `${frame.sessionId}:${connectionEpoch}`;
        if (lastSubscriptionAckKeyRef.current === ackKey) {
          return;
        }
        lastSubscriptionAckKeyRef.current = ackKey;
        setRestoreError(undefined);
        return;
      }
      if (frame.type === 'event' && typeof frame.event === 'object' && frame.event) {
        const relayEvent = frame.event as { sessionId?: unknown; type?: unknown; payload?: unknown };
        if (
          relayEvent.type === 'session.agent-id-updated' &&
          relayEvent.sessionId === currentSessionIdRef.current &&
          relayEvent.payload &&
          typeof relayEvent.payload === 'object' &&
          typeof (relayEvent.payload as { agentSessionId?: unknown }).agentSessionId === 'string'
        ) {
          setAgentSessionId((relayEvent.payload as { agentSessionId: string }).agentSessionId);
        }
        return;
      }
      if (frame.type === 'gateway.chat-catchup') {
        return;
      }
      if (frame.type === 'user.message' && typeof frame.text === 'string') {
        const frameSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
        if (!frameSessionId || frameSessionId !== currentSessionIdRef.current) {
          return;
        }
        const structuredEvent = mapRelayFrameToChatEvent({ frame, provider: activeSessionProviderRef.current ?? 'agent' });
        if (structuredEvent) {
          handleStructuredEvent(frameSessionId, structuredEvent);
          return;
        }
        return;
      }
      if (frame.type === 'agent.delta' && typeof frame.text === 'string') {
        const frameSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
        if (!frameSessionId || frameSessionId !== currentSessionIdRef.current) {
          return;
        }
        const structuredEvent = mapRelayFrameToChatEvent({ frame, provider: activeSessionProviderRef.current ?? 'agent' });
        if (structuredEvent) {
          handleStructuredEvent(frameSessionId, structuredEvent);
        }
        return;
      }
      if (frame.type === 'agent.result' && typeof frame.text === 'string') {
        const frameSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
        if (!frameSessionId || frameSessionId !== currentSessionIdRef.current) {
          return;
        }
        const structuredEvent = mapRelayFrameToChatEvent({ frame, provider: activeSessionProviderRef.current ?? 'agent' });
        if (structuredEvent) {
          handleStructuredEvent(frameSessionId, structuredEvent);
          pendingClientRequestIdRef.current = null;
          setIsInflight(false);
        }
        return;
      }
      if (frame.type === 'agent.tool' && typeof frame.name === 'string') {
        const frameSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
        if (!frameSessionId || frameSessionId !== currentSessionIdRef.current) {
          return;
        }
        const structuredEvent = mapRelayFrameToChatEvent({ frame, provider: activeSessionProviderRef.current ?? 'agent' });
        if (structuredEvent) {
          handleStructuredEvent(frameSessionId, structuredEvent);
        }
        return;
      }
      if (frame.type === 'agent.permission_request' && typeof frame.requestId === 'string' && typeof frame.toolName === 'string') {
        const frameSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
        if (!frameSessionId || frameSessionId !== currentSessionIdRef.current) {
          return;
        }
        const structuredEvent = mapRelayFrameToChatEvent({ frame, provider: activeSessionProviderRef.current ?? 'agent' });
        if (structuredEvent) {
          handleStructuredEvent(frameSessionId, structuredEvent);
        }
        return;
      }
      if (frame.type === 'error' && typeof frame.message === 'string') {
        if (typeof frame.sessionId === 'string' && frame.sessionId && frame.sessionId !== currentSessionIdRef.current) {
          return;
        }
        const frameMessage = frame.message;
        if (frame.code === 'session_not_found') {
          // Session not yet known to relay (race on reconnect). Clear subscription
          // state so the subscribe effect retries when sessions broadcast arrives.
          subscribedSessionIdRef.current = null;
          return;
        }
        if (frame.code === 'gateway_required') {
          setConnectionError(t.gatewaySelectorNoSelection);
          setIsInflight(false);
          pendingClientRequestIdRef.current = null;
          return;
        }
        if (frame.code === 'gateway_unauthorized') {
          setConnectionError('Gateway 不属于当前账号');
          setIsInflight(false);
          pendingClientRequestIdRef.current = null;
          return;
        }
        if (
          frame.code === 'gateway_unavailable' ||
          frame.code === 'forbidden' ||
          frame.code === 'wrong_ticket_scope'
        ) {
          if (!shouldApplyGatewayUnavailable({
            activeSessionId: currentSessionIdRef.current,
            frameSessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined
          })) {
            return;
          }
          if (frame.code === 'forbidden' && frameMessage === 'session is outside client scope') {
            setSessionAccessError(t.chatsSessionOutsideGateway);
          } else {
            setConnectionError(frame.code === 'gateway_unavailable' ? t.gatewayNotConnected : frameMessage);
          }
          setIsInflight(false);
          pendingClientRequestIdRef.current = null;
          return;
        }
        if (frame.code === 'session_lost') {
          const agentId = errorAgentId(frame, pendingClientRequestIdRef.current);
          setMessages((items) =>
            items.map((item) =>
              item.kind === 'agent' && item.id === agentId
                ? { ...item, isStreaming: false, isWaiting: false, isLost: true }
                : item
            )
          );
          setIsInflight(false);
          if (typeof frame.sessionId === 'string' && frame.sessionId === pendingCreatedSessionIdRef.current) {
            pendingCreatedSessionIdRef.current = null;
          }
        } else {
          const agentId = errorAgentId(frame, pendingClientRequestIdRef.current);
          pendingClientRequestIdRef.current = null;
          setMessages((items) => {
            const nextItems = agentId
              ? items.map((item) =>
                  item.kind === 'agent' && item.id === agentId
                    ? { ...item, isStreaming: false, isWaiting: false, isLost: true }
                    : item
                )
              : items;
            return [...nextItems, { kind: 'system', id: `error-${Date.now()}`, text: frameMessage }];
          });
          setIsInflight(false);
        }
      }
  }, [clearGatewayNotConnectedError, connectionEpoch, handleStructuredEvent, navigate, selectedGatewayId, t.chatsProviderFail, t.chatsSessionOutsideGateway, t.chatsSessionStarted, t.gatewayNotConnected, t.gatewaySelectorNoSelection]);

  React.useEffect(() => subscribeFrame(handleRelayFrame), [handleRelayFrame, subscribeFrame]);
  React.useEffect(() => subscribeClose(handleRelayClose), [handleRelayClose, subscribeClose]);

  React.useEffect(() => {
    const preferredGatewayId =
      selectedGatewayIdRef.current ??
      activeSessionGatewayIdRef.current ??
      defaultGatewayId;
    if (preferredGatewayId) {
      setSelectedGatewayId((current) => current ?? preferredGatewayId);
    }
    if (wsReady && gatewayConnected) {
      hasEverConnectedRef.current = true;
      clearGatewayNotConnectedError();
    }
  }, [clearGatewayNotConnectedError, defaultGatewayId, gatewayConnected, wsReady]);

  React.useEffect(() => {
    if (!wsReady || connectionEpoch <= 1 || connectionEpoch === lastCatchupConnectionEpochRef.current) {
      return;
    }
    lastCatchupConnectionEpochRef.current = connectionEpoch;
    onReconnectCatchup?.();
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    lastSubscriptionAckKeyRef.current = null;
    const restoreAttemptId = `restore-${sessionId}-${++restoreAttemptSeqRef.current}`;
    restoreAttemptIdRef.current = restoreAttemptId;
    setIsRestoring(true);
    void loadActiveSessionMetadata(sessionId, { restoreAttemptId }).catch(() => {
      if (restoreAttemptIdRef.current === restoreAttemptId && currentSessionIdRef.current === sessionId) {
        setActiveSessionMetadataReady(true);
      }
    });
    void loadActiveSessionHistory(sessionId, { protectNewerLocal: true, restoreAttemptId })
      .then((applied) => {
        if (!applied || restoreAttemptIdRef.current !== restoreAttemptId) return;
        setRestoreError(undefined);
      })
      .catch(() => {
        if (restoreAttemptIdRef.current !== restoreAttemptId || currentSessionIdRef.current !== sessionId) return;
        restoreBufferRef.current = null;
        setRestoreError(t.chatsHistoryFail);
      })
      .finally(() => {
        if (restoreAttemptIdRef.current === restoreAttemptId) {
          setIsRestoring(false);
        }
      });
  }, [connectionEpoch, loadActiveSessionHistory, loadActiveSessionMetadata, onReconnectCatchup, t.chatsHistoryFail, wsReady]);

  React.useEffect(() => {
    if (!cwdPickerOpen || currentSessionId || !wsReady || !selectedGatewayId) {
      setCwdSuggestions([]);
      setCwdSuggestionsLoading(false);
      setCwdActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => {
      setCwdSuggestionsLoading(true);
      sendFrame({ type: 'client.cwd-suggest', cwd, gatewayId: selectedGatewayId });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, cwd, cwdPickerOpen, selectedGatewayId, sendFrame, wsReady]);

  React.useEffect(() => {
    if (currentSessionId || !selectedGatewayId) {
      return;
    }
    if (previousSelectedGatewayIdRef.current === selectedGatewayId) {
      return;
    }
    previousSelectedGatewayIdRef.current = selectedGatewayId;
    setCwd('~');
    setCwdSuggestions([]);
    setCwdSuggestionsLoading(false);
    setCwdActiveIndex(0);
    setProviderOptions(DEFAULT_PROVIDER_OPTIONS);
    setSelectedProvider(DEFAULT_PROVIDER_OPTIONS[0]!.provider);
    setSelectedModel(DEFAULT_PROVIDER_OPTIONS[0]!.models[0]!);
    if (wsReady) {
      providerRequestKeyRef.current = selectedGatewayId;
      sendFrame({ type: 'client.list-providers', gatewayId: selectedGatewayId });
      if (cwdPickerOpen) {
        setCwdSuggestionsLoading(true);
        sendFrame({ type: 'client.cwd-suggest', cwd: '~', gatewayId: selectedGatewayId });
      }
    }
  }, [currentSessionId, cwdPickerOpen, selectedGatewayId, sendFrame, wsReady]);

  React.useEffect(() => {
    if (currentSessionId) {
      setRecentCwdSuggestions([]);
      return;
    }
    setRecentCwdSuggestions(readRecentCwds(selectedGatewayId, selectedProvider));
  }, [currentSessionId, selectedGatewayId, selectedProvider]);

  React.useEffect(() => {
    if (currentSessionId || !wsReady || !selectedGatewayId || providerRequestKeyRef.current === selectedGatewayId) {
      return;
    }
    providerRequestKeyRef.current = selectedGatewayId;
    sendFrame({ type: 'client.list-providers', gatewayId: selectedGatewayId });
  }, [currentSessionId, selectedGatewayId, sendFrame, wsReady]);

  React.useEffect(() => {
    const models = providerOptions.find((provider) => provider.provider === selectedProvider)?.models ?? [];
    if (models.length > 0 && !models.includes(selectedModel)) {
      setSelectedModel(models[0]!);
    }
  }, [providerOptions, selectedModel, selectedProvider]);

  React.useEffect(() => {
    if (!wsReady) {
      return;
    }
    const previousSessionId = subscribedSessionIdRef.current;
    if (previousSessionId && previousSessionId !== currentSessionId) {
      releaseSessionSubscriptionRef.current?.();
      releaseSessionSubscriptionRef.current = null;
      subscribedSessionIdRef.current = null;
      restoreBufferRef.current = null;
    }
    if (!currentSessionId || !activeSessionMetadataReady) {
      return;
    }
    if (subscribedSessionIdRef.current === currentSessionId) {
      return;
    }
    setSessionAccessError(undefined);
    restoreBufferRef.current = isRestoring
      ? createRestoreBuffer({
          attemptId: restoreAttemptIdRef.current ?? `restore-${currentSessionId}-${connectionEpoch}`,
          sessionId: currentSessionId
        })
      : null;
    releaseSessionSubscriptionRef.current = acquireSessionSubscription({
      owner: `chat:${currentSessionId}`,
      sessionId: currentSessionId,
      mode: 'control',
      after: 0
    });
    subscribedSessionIdRef.current = currentSessionId;
  }, [acquireSessionSubscription, activeSessionMetadataReady, connectionEpoch, currentSessionId, isRestoring, wsReady, subscribeRetryKey]);

  React.useEffect(() => {
    return () => {
      const sessionId = subscribedSessionIdRef.current;
      if (sessionId) {
        releaseSessionSubscriptionRef.current?.();
        releaseSessionSubscriptionRef.current = null;
        subscribedSessionIdRef.current = null;
      }
    };
  }, []);

  const retryRestore = React.useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      return;
    }
    const restoreAttemptId = `restore-${sessionId}-${++restoreAttemptSeqRef.current}`;
    restoreAttemptIdRef.current = restoreAttemptId;
    releaseSessionSubscriptionRef.current?.();
    releaseSessionSubscriptionRef.current = null;
    subscribedSessionIdRef.current = null;
    restoreBufferRef.current = null;
    lastSubscriptionAckKeyRef.current = null;
    setRestoreError(undefined);
    setIsRestoring(true);
    void loadActiveSessionMetadata(sessionId, { restoreAttemptId }).catch(() => {
      if (restoreAttemptIdRef.current === restoreAttemptId && currentSessionIdRef.current === sessionId) {
        setActiveSessionMetadataReady(true);
      }
    });
    void loadActiveSessionHistory(sessionId, { restoreAttemptId })
      .then((applied) => {
        if (!applied || restoreAttemptIdRef.current !== restoreAttemptId) return;
        setRestoreError(undefined);
      })
      .catch(() => {
        if (restoreAttemptIdRef.current !== restoreAttemptId || currentSessionIdRef.current !== sessionId) return;
        restoreBufferRef.current = null;
        setRestoreError(t.chatsHistoryFail);
      })
      .finally(() => {
        if (restoreAttemptIdRef.current === restoreAttemptId) {
          setIsRestoring(false);
        }
      });
    setSubscribeRetryKey((key) => key + 1);
  }, [loadActiveSessionHistory, loadActiveSessionMetadata, t.chatsHistoryFail]);

  const sendMessage = React.useCallback(() => {
    const text = inputText.trim();
    if (!text || isInflight || !wsReady || connectionError || sessionAccessError) return;
    const existingProviderModels = providerOptions.find((provider) => provider.provider === activeSessionProvider)?.models ?? [];
    const messageProvider = currentSessionId ? (activeSessionProvider ?? 'agent') : selectedProvider;
    const messageModel = currentSessionId ? (activeSessionModel ?? existingProviderModels[0]) : selectedModel;
    if (!currentSessionId && !selectedGatewayId) {
      setConnectionError(t.gatewaySelectorNoSelection);
      return;
    }
    if (!currentSessionId && selectedGatewayId && !gatewayIdsOnline.has(selectedGatewayId)) {
      setConnectionError(t.gatewaySelectorOffline);
      return;
    }
    inflightStartedAtRef.current = Date.now();
    const now = Date.now();
    const clientRequestId = createClientRequestId(now);
    const optimisticTurn = createOptimisticTurn({
      clientRequestId,
      now,
      provider: messageProvider,
      text
    });
    pendingClientRequestIdRef.current = clientRequestId;
    setMessages((items) => [
      ...items,
      optimisticTurn.user,
      optimisticTurn.agent
    ]);
    setInputText('');
    setIsInflight(true);
    if (currentSessionId) {
      sendFrame({ type: 'client.chat', sessionId: currentSessionId, message: text, model: messageModel, clientRequestId });
      return;
    }
    pendingSessionProviderRef.current = selectedProvider;
    pendingSessionModelRef.current = selectedModel;
    setRecentCwdSuggestions(rememberRecentCwd(selectedGatewayId, selectedProvider, cwd));
    sendFrame({
      type: 'client.chat',
      sessionId: null,
      provider: selectedProvider,
      model: selectedModel,
      cwd,
      message: text,
      gatewayId: selectedGatewayId,
      clientRequestId
    });
  }, [activeSessionModel, activeSessionProvider, connectionError, cwd, currentSessionId, gatewayIdsOnline, inputText, isInflight, providerOptions, selectedGatewayId, selectedModel, selectedProvider, sendFrame, sessionAccessError, t.gatewaySelectorNoSelection, t.gatewaySelectorOffline, wsReady]);

  const sendPermissionResponse = React.useCallback((requestId: string, decision: 'allow' | 'deny') => {
    if (!wsReady || !currentSessionIdRef.current) return;
    setMessages((items) => items.map((item) =>
      item.kind === 'permission' && item.requestId === requestId ? { ...item, decided: decision } : item
    ));
    sendFrame({ type: 'client.permission_response', sessionId: currentSessionIdRef.current, requestId, decision });
  }, [sendFrame, wsReady]);

  const applyNextSuggestion = React.useCallback((description: string) => {
    setInputText(description);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const length = description.length;
      inputRef.current?.setSelectionRange(length, length);
    });
  }, []);

  const appendNextSuggestion = React.useCallback((description: string) => {
    setInputText((current) => {
      const prefix = current.trim().length > 0 ? `${current.trimEnd()}\n\n` : '';
      return `${prefix}${description}`;
    });
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const length = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(length, length);
    });
  }, []);

  const isNewSession = !currentSessionId && messages.length === 0;

  const slashMenu = useSlashMenu({
    inputText,
    onSelect: (name) => {
      setInputText(`/${name} `);
      window.requestAnimationFrame(() => {
        (inputRef.current ?? newSessionInputRef.current)?.focus();
      });
    }
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenu.handleKeyDown(event)) return;
    const nativeEvent = event.nativeEvent as KeyboardEvent;
    const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
      event.preventDefault();
      sendMessage();
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
  };

  const effectiveGatewayId = currentSessionId ? (activeSessionGatewayId ?? selectedGatewayId) : selectedGatewayId;
  const selectedGatewayOnline = effectiveGatewayId ? gatewayIdsOnline.has(effectiveGatewayId) : false;
  const displayGatewayName = currentSessionId
    ? (activeSessionGatewayId ? gatewayNamesById[activeSessionGatewayId] : undefined)
    : selectedGatewayName;
  const gatewayInputMessage = !effectiveGatewayId
    ? t.gatewaySelectorNoSelection
    : selectedGatewayOnline
      ? undefined
      : t.gatewaySelectorOffline;

  const buildInputPlaceholder = (provider: string, model: string, gatewayName?: string) => {
    const parts: string[] = [];
    if (gatewayName) parts.push(gatewayName);
    if (provider) parts.push(provider.charAt(0).toUpperCase() + provider.slice(1));
    if (model) parts.push(model.charAt(0).toUpperCase() + model.slice(1));
    return `${t.chatsSendTo} ${parts.join(' · ')}…`;
  };
  const isGatewayInputBlocked = Boolean(gatewayInputMessage);
  const canSend = wsReady && !isInflight && !connectionError && !sessionAccessError && !isGatewayInputBlocked && inputText.trim().length > 0;
  const isInputDisabled = isInflight || !wsReady || Boolean(connectionError) || Boolean(sessionAccessError) || isGatewayInputBlocked;
  const relayConnection = (() => {
    if (wsReady) {
      return { state: 'connected' as const, label: t.chatsRelayConnected };
    }
    if (hasEverConnectedRef.current) {
      return { state: 'error' as const, label: t.chatsRelayDisconnected };
    }
    return { state: 'connecting' as const, label: t.chatsRelayConnecting };
  })();

  const gatewayConnection = (() => {
    if (connectionError) {
      return { state: 'error' as const, label: connectionError };
    }
    if (wsReady && gatewayConnected) {
      return { state: 'connected' as const, label: t.chatsGatewayConnected };
    }
    if (wsReady) {
      return { state: 'connecting' as const, label: t.chatsGatewayWaiting };
    }
    return { state: 'unknown' as const, label: t.chatsGatewayUnknown };
  })();

  const connectionStatusChips = (
    <WorkbenchCompactConnectionStatus
      gateway={gatewayConnection}
      relay={relayConnection}
    />
  );

  const gatewaySelector = (
    <GatewaySelector
      selectedGatewayId={currentSessionId ? activeSessionGatewayId : selectedGatewayId}
      onSelect={(id, name) => {
        if (currentSessionId) {
          return;
        }
        setSelectedGatewayId(id);
        setSelectedGatewayName(name);
        setCwd('~');
        setCwdSuggestions([]);
        setCwdSuggestionsLoading(false);
        setCwdActiveIndex(0);
        if (wsReady) {
          providerRequestKeyRef.current = id;
          sendFrame({ type: 'client.list-providers', gatewayId: id });
          if (cwdPickerOpen) {
            setCwdSuggestionsLoading(true);
            sendFrame({ type: 'client.cwd-suggest', cwd: '~', gatewayId: id });
          }
        }
        setConnectionError((current) =>
          current === t.gatewaySelectorNoSelection || current === t.gatewaySelectorOffline
            ? undefined
            : current
        );
      }}
      onGatewayName={(_, name) => {
        setSelectedGatewayName(name);
      }}
      onlineGatewayIds={gatewayIdsOnline}
      readonly={Boolean(currentSessionId)}
    />
  );

  const sendButton = (
    <ComposerSubmitButton
      onClick={sendMessage}
      disabled={!canSend}
      loading={isInflight}
      title={t.send}
    />
  );

  const displayProvider = currentSessionId ? (activeSessionProvider ?? 'agent') : selectedProvider;
  const displayProviderModels = providerOptions.find((provider) => provider.provider === displayProvider)?.models ?? [];
  const displayModel = currentSessionId ? (activeSessionModel ?? displayProviderModels[0]) : selectedModel;
  const slashMenuEl = (
    <SlashCommandMenu
      open={slashMenu.open}
      commands={slashMenu.filteredCommands}
      activeIndex={slashMenu.activeIndex}
      onSelect={slashMenu.handleSelect}
      onActiveIndexChange={slashMenu.setActiveIndex}
    />
  );

  const inputCard = (withControls: boolean) => (
    <div className="chat-input-card relative overflow-hidden rounded-2xl border border-border" style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.07)' }}>
      <Textarea
        ref={withControls ? newSessionInputRef : undefined}
        value={inputText}
        onChange={(event) => setInputText(event.target.value)}
        placeholder={gatewayInputMessage ?? buildInputPlaceholder(
          withControls ? selectedProvider : displayProvider,
          withControls ? selectedModel : displayModel,
          withControls && selectedGatewayOnline ? selectedGatewayName : undefined
        )}
        disabled={isInputDisabled}
        className="max-h-44 min-h-[88px] resize-none rounded-none border-0 bg-transparent px-4 pt-4 text-[15px] leading-relaxed shadow-none focus-visible:bg-transparent focus-visible:ring-0 dark:bg-transparent dark:focus-visible:bg-transparent"
        onKeyDown={onKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
      <div className={`chat-input-toolbar ${withControls ? 'chat-input-toolbar-controls' : 'chat-input-toolbar-session'} relative flex items-center gap-2 border-t border-border/50 px-3 py-2.5`}>
        {withControls && (
          <>
            <Select
              value={selectedProvider}
              onValueChange={(value) => {
                setSelectedProvider(value);
                setSelectedModel(providerOptions.find((p) => p.provider === value)?.models[0] ?? '');
              }}
            >
              <SelectTrigger className="chat-provider-trigger chat-toolbar-trigger w-auto capitalize">
                <SelectValue placeholder={t.chatsSelectProvider} />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((p) => (
                  <SelectItem key={p.provider} value={p.provider}>{p.provider.charAt(0).toUpperCase() + p.provider.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedModel} onValueChange={setSelectedModel}>
              <SelectTrigger className="chat-model-trigger chat-toolbar-trigger w-auto capitalize">
                <SelectValue placeholder={t.chatsSelectModel} />
              </SelectTrigger>
              <SelectContent>
                {(providerOptions.find((p) => p.provider === selectedProvider)?.models ?? []).map((model) => (
                  <SelectItem key={model} value={model}>{model.charAt(0).toUpperCase() + model.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {gatewaySelector}
            <PathPicker
              activeIndex={cwdActiveIndex}
              emptyLabel={wsReady ? t.chatsCwd : t.gatewayNotConnected}
              inputPlaceholder={t.chatsCwd}
              loading={cwdSuggestionsLoading}
              loadingLabel={t.chatsCwdLoading}
              onActiveIndexChange={setCwdActiveIndex}
              onOpenChange={(open) => {
                setCwdPickerOpen(open);
                if (open && wsReady && selectedGatewayId) {
                  setCwdSuggestionsLoading(true);
                  sendFrame({ type: 'client.cwd-suggest', cwd, gatewayId: selectedGatewayId });
                }
                if (!open) {
                  setCwdSuggestionsLoading(false);
                }
              }}
              onValueChange={setCwd}
              open={cwdPickerOpen}
              recentSuggestions={recentCwdSuggestions}
              recentTitle="最近使用"
              selectLabel={t.chatsCwdSelect}
              suggestions={cwdSuggestions}
              triggerLabel={t.chatsCwdShort}
              value={cwd}
            />
            <div className="flex-1" />
          </>
        )}
        {!withControls && (
          <>
            {displayProviderModels.length > 0 && displayModel && (
              <Select value={displayModel} onValueChange={setActiveSessionModel}>
                <SelectTrigger className="chat-model-trigger h-7 w-auto gap-1 rounded-full border-0 bg-muted px-3 text-[12px] font-medium shadow-none ring-0 focus:ring-0">
                  <SelectValue placeholder={t.chatsSelectModel} />
                </SelectTrigger>
                <SelectContent>
                  {displayProviderModels.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="flex-1" />
            {usageStats && (
              <UsageStatsChip contextPct={usageStats.contextPct} rateLimitResetsAt={usageStats.rateLimitResetsAt} rateLimitType={usageStats.rateLimitType} />
            )}
          </>
        )}
        {sendButton}
      </div>
    </div>
  );

  if (isNewSession) {
    return (
      <NewChatSurface
        composer={(
          <div className="relative">
            {slashMenuEl}
            {inputCard(true)}
          </div>
        )}
        connectionStatusChips={connectionStatusChips}
        connectionReady={wsReady && gatewayConnected && !connectionError}
        gatewayNamesById={gatewayNamesById}
        onExpandSidebar={onExpandSidebar}
        onOpenDrawer={onOpenDrawer}
        t={t}
      />
    );
  }

  const lastAgentIndex = findLastAgentIndex(messages);

  return (
    <div className="chat-surface flex h-full flex-col bg-background">
      <ChatHeader
        agentSessionId={agentSessionId}
        connectionStatusChips={connectionStatusChips}
        copiedAgentId={copiedAgentId}
        displayProvider={displayProvider}
        gatewayNamesById={gatewayNamesById}
        onCopyAgentSession={() => {
          if (!agentSessionId) return;
          const cmd = providerResumeCommand(displayProvider, agentSessionId);
          void navigator.clipboard.writeText(cmd);
          setCopiedAgentId(true);
          setTimeout(() => setCopiedAgentId(false), 1500);
        }}
        onExpandSidebar={onExpandSidebar}
        onOpenDrawer={onOpenDrawer}
        sessionAccessError={sessionAccessError}
        t={t}
      />

      {(isRestoring || restoreError) && (
        <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">{restoreError ?? t.chatsRestoring}</span>
          {restoreError && (
            <Button size="sm" variant="outline" onClick={retryRestore}>
              {t.chatRetry}
            </Button>
          )}
        </div>
      )}

      <ChatMessageList
        lastAgentIndex={lastAgentIndex}
        messageEndRef={messageEndRef}
        messageScrollRef={messageScrollRef}
        messages={messages}
        onChoiceClick={appendNextSuggestion}
        onCommandClick={applyNextSuggestion}
        onPermissionResponse={sendPermissionResponse}
        onSuggestionClick={applyNextSuggestion}
      />

      <ChatComposer
        activeSessionProjectPath={activeSessionProjectPath}
        buildInputPlaceholder={buildInputPlaceholder}
        displayGatewayName={displayGatewayName}
        displayModel={displayModel}
        displayModelOptions={displayProviderModels}
        displayProvider={displayProvider}
        inputRef={inputRef}
        inputText={inputText}
        isInputDisabled={isInputDisabled}
        onCompositionEnd={handleCompositionEnd}
        onCompositionStart={handleCompositionStart}
        onInputChange={setInputText}
        onKeyDown={onKeyDown}
        sendButton={sendButton}
        sessionSettingsOpen={sessionSettingsOpen}
        setActiveSessionModel={setActiveSessionModel}
        setSessionSettingsOpen={setSessionSettingsOpen}
        slashMenuEl={slashMenuEl}
        t={t}
        usageStats={usageStats}
      />
    </div>
  );
}
