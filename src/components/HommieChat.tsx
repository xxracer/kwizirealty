'use client';

import { useState, useEffect, useRef } from 'react';
import { useChat } from 'ai/react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, X, Send, Bot, User, Maximize2, Minimize2, Trash2 } from 'lucide-react';
import { BoundaryKey } from '@/lib/engine';
import { METRICS } from '@/lib/metrics';

interface HommieChatProps {
  boundary: BoundaryKey | null;
  metricLabel: string;
  reportStats: any;
  marketHealth: any;
  selectedIds: string[];
  /** Display names of the currently selected areas — lets the model re-select
   *  them ("generate the report" with no area named) via selectMapAreas. */
  selectedAreaNames?: string[];
  /** Returns the display names that actually matched on the active boundary
   *  layer, or null when nothing matched — so the chat can report failures. */
  onAreaSelect?: (queries: string[], generateReportAfter?: boolean) => string[] | null | void;
  onGenerateReport?: () => void;
  getStatsForChatQueries?: (queries: string[]) => any;
  /** Real-time aggregates for the filters the bot is about to apply, so the
   *  model can answer "how many / what average" in the same turn. */
  getStatsForChatFilters?: (filters: any) => any;
  setBoundary?: (boundary: BoundaryKey) => void;
  setMetric?: any;
  setFilters?: any;
  /** When this changes (non-null), a local assistant message is appended to the
   *  chat without going through the model. Used to reliably announce "your
   *  report is ready" the moment the report finishes generating. */
  reportReadyMsg?: { id: number; text: string } | null;
}

/**
 * Values the map actually accepts. The model was previously offered
 * 'counties'/'cities'/'school_districts' and metrics like 'DOM'/'MOI' that
 * don't exist in the engine — setting them blanked the map or silently
 * re-colored it by close price. Validate every bot-driven change against
 * these lists and bounce invalid values back to the model.
 */
const VALID_BOUNDARIES: BoundaryKey[] = [
  'subdivisions',
  'zipcodes',
  'highschools',
  'elementary',
  'middle',
  'neighborhoods',
  'areas',
];

/** Shown locally (no AI call) when the user clicks the 🚀 Get Started button. */
const GET_STARTED_HELP = `👋 Welcome! Here's how to use me:

To generate a report, simply type report followed by the area name — for example:

• "report for Katy and Sugar Land"
• "report for Tomball"
• "report for Richmond"

I'll automatically select that area on the map and generate the full report for you — prices, market health and more.

You can also ask me to:
• Compare areas — "compare Bellaire and Westchase"
• Highlight an area without a report — "show me Cypress"
• Change the map metric — "show price per sqft"
• Filter properties — "show me 4 bedroom homes under $500k"`;

function InteractiveQuestion({ toolInvocation, addToolResult }: { toolInvocation: any, addToolResult: any }) {
  const { question, options, isMultiSelect } = toolInvocation.args;
  const [selected, setSelected] = useState<string[]>([]);

  if ('result' in toolInvocation) {
    return (
      <div className="flex flex-col space-y-3 mt-3 border-t border-gray-100 pt-3">
        <div className="font-medium text-gray-800">{question}</div>
        <div className="text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg text-sm border border-indigo-100">
          ✓ Selected: {toolInvocation.result}
        </div>
      </div>
    );
  }

  const toggleSelection = (option: string) => {
    setSelected(prev => 
      prev.includes(option) ? prev.filter(o => o !== option) : [...prev, option]
    );
  };

  return (
    <div className="flex flex-col space-y-3 mt-3 border-t border-gray-100 pt-3">
      <div className="font-medium text-gray-800">{question}</div>
      <div className="flex flex-col space-y-2">
        {options.map((option: string, idx: number) => (
          <button
            key={idx}
            onClick={() => {
              if (isMultiSelect) {
                toggleSelection(option);
              } else {
                addToolResult({ toolCallId: toolInvocation.toolCallId, result: option });
              }
            }}
            className={`text-left px-4 py-2.5 rounded-xl border transition-all shadow-sm flex items-center ${
              selected.includes(option) 
                ? 'bg-indigo-50 border-indigo-400 text-indigo-800' 
                : 'bg-white border-gray-200 text-gray-700 hover:bg-indigo-50/50 hover:border-indigo-300 hover:text-indigo-700'
            }`}
          >
            {isMultiSelect && (
              <div className={`mr-3 w-4 h-4 border rounded flex items-center justify-center shrink-0 ${selected.includes(option) ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'}`}>
                {selected.includes(option) && <X className="w-3 h-3 text-white" style={{ clipPath: 'polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%)' }} />}
              </div>
            )}
            {option}
          </button>
        ))}
      </div>
      {isMultiSelect && (
        <button
          onClick={() => addToolResult({ toolCallId: toolInvocation.toolCallId, result: selected.join(' / ') })}
          disabled={selected.length === 0}
          className="mt-2 w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white rounded-xl font-medium transition-colors"
        >
          Submit Selection
        </button>
      )}
    </div>
  );
}

export default function HommieChat({
  boundary,
  metricLabel,
  reportStats,
  marketHealth,
  selectedIds,
  selectedAreaNames,
  onAreaSelect,
  onGenerateReport,
  getStatsForChatQueries,
  getStatsForChatFilters,
  setBoundary,
  setMetric,
  setFilters,
  reportReadyMsg
}: HommieChatProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Filter announcement queued during the stream. Appending it directly inside
  // onToolCall gets WIPED by the next onUpdate (the SDK replaces the messages
  // array while the stream is still running), so it is flushed once the
  // request finishes (isLoading false).
  const pendingFilterAnnouncement = useRef<{ id: string; text: string } | null>(null);
  // Tool results held back on purpose. The user wants the bot's answer to
  // arrive AFTER the report popup finishes loading — and adding a tool result
  // is what triggers the model's roundtrip, so we hold them until the parent
  // signals the report is ready (reportReadyMsg) and only then flush.
  const heldToolResults = useRef<Array<{ toolCallId: string; result: any }>>([]);
  
  // Construct context object to send to the AI
  const contextData = {
    boundary,
    selectedAreasCount: selectedIds.length,
    selectedAreaNames: selectedAreaNames || [],
    metricLabel,
    reportStats,
    marketHealth,
  };

  const greetingMessage = {
    id: 'welcome',
    role: 'assistant' as const,
    content: "Hi! I'm Hommie, your AI assistant. Ask me anything about Houston real estate, the current map data, or demographic trends!"
  };

  const { messages, input, handleInputChange, handleSubmit, isLoading, setMessages, append, addToolResult } = useChat({
    api: '/api/chat',
    maxToolRoundtrips: 2,
    body: {
      contextData,
    },
    initialMessages: [greetingMessage],
    // Failures used to be invisible (no bubble, no log the user could find).
    onError: (err) => {
      console.error('[Hommie] chat request failed:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: `chat-error-${Date.now()}`,
          role: 'assistant' as const,
          content: '⚠️ I could not reach the assistant. Check your connection and try again.',
        },
      ]);
    },
    onToolCall: async ({ toolCall }) => {
      console.info('[Hommie] tool call:', toolCall.toolName, JSON.stringify(toolCall.args));
      if (toolCall.toolName === 'selectMapAreas') {
        const args = toolCall.args as { areasToSearch: string[]; generateReport: boolean };
        const { areasToSearch, generateReport } = args;

        console.info('[Hommie] selectMapAreas:', areasToSearch, 'generateReport:', generateReport);
        try {
          let toolResultData = null;
          let matchedNames: string[] | null = null;
          if (onAreaSelect && areasToSearch && areasToSearch.length > 0) {
            // Always defer report generation through the parent's pending-flag
            // + useEffect pattern. Calling onGenerateReport() synchronously here
            // would read the pre-commit selectedIds (length === 0) and bail
            // with "Select one or more areas on the map" even though we just
            // matched them.
            matchedNames = (onAreaSelect(areasToSearch, generateReport && !!onGenerateReport) as string[] | null) ?? null;
            if (getStatsForChatQueries) {
              toolResultData = getStatsForChatQueries(areasToSearch);
            }
          } else if (generateReport && onGenerateReport) {
            // No areas to select — fire the report immediately.
            onGenerateReport();
          }

          if (matchedNames && matchedNames.length > 0 && generateReport && onGenerateReport) {
            // HOLD the tool result: the answer must arrive AFTER the report
            // popup finishes loading. The parent bumps reportReadyMsg when the
            // report is done, and that effect flushes this result — which is
            // what makes the model answer at exactly that moment.
            heldToolResults.current.push({
              toolCallId: toolCall.toolCallId,
              result: {
                success: true,
                matchedAreas: matchedNames,
                reportQueued: true,
                message: `The report finished generating and is now displayed on screen for: ${matchedNames.join(', ')}. Respond with a brief, friendly confirmation naming the areas and confirming the report is ready. Do not stay silent.`,
                data: toolResultData,
              },
            });
            // Safety net: if the report never finishes (load error, cancelled,
            // etc.), flush the held result anyway so the model answers instead
            // of leaving the tool call pending forever.
            window.setTimeout(() => {
              const still = heldToolResults.current.find((h) => h.toolCallId === toolCall.toolCallId);
              if (!still) return;
              heldToolResults.current = heldToolResults.current.filter((h) => h.toolCallId !== toolCall.toolCallId);
              addToolResult({
                toolCallId: still.toolCallId,
                result: {
                  ...still.result,
                  reportQueued: false,
                  message:
                    'The report did not finish loading. Tell the user the report could not be generated right now and suggest trying again or picking a smaller area.',
                },
              });
            }, 120000);
          } else {
            addToolResult({
              toolCallId: toolCall.toolCallId,
              result: matchedNames && matchedNames.length > 0
                ? {
                    success: true,
                    matchedAreas: matchedNames,
                    reportQueued: generateReport,
                    message: `Matched and selected: ${matchedNames.join(', ')}. Now respond with a brief confirmation naming what was selected.`,
                    data: toolResultData,
                  }
                : {
                    success: false,
                    noMatch: true,
                    message: `NO areas on the current map boundary matched: ${JSON.stringify(areasToSearch)}. Do NOT claim anything was selected or that a report was generated. Instead, apologize and tell the user you could not find those areas on the current boundary layer, and suggest trying a ZIP code or a nearby city name, or switching the boundary layer.`,
                  },
            });
          }
        } catch (error) {
          addToolResult({
            toolCallId: toolCall.toolCallId,
            result: { error: 'Failed to select areas or generate report.' },
          });
        }
      } else if (toolCall.toolName === 'setMapBoundary') {
        if (setBoundary) {
          const requested = (toolCall.args as any).boundary as BoundaryKey;
          if (VALID_BOUNDARIES.includes(requested)) {
            setBoundary(requested);
            addToolResult({ toolCallId: toolCall.toolCallId, result: { success: true, message: `Map boundary set to ${requested}` } });
          } else {
            addToolResult({
              toolCallId: toolCall.toolCallId,
              result: {
                error: `"${requested}" is not a valid boundary. Valid options: ${VALID_BOUNDARIES.join(', ')}. Retry with one of those exact values.`,
              },
            });
          }
        }
      } else if (toolCall.toolName === 'setMapMetric') {
        if (setMetric) {
          const requested = (toolCall.args as any).metric as string;
          // Accept either the canonical key or its display label ("Sales Price").
          const validMetric = METRICS.find(
            (m) => m.key === requested || m.label.toLowerCase() === String(requested || '').toLowerCase()
          );
          if (validMetric) {
            setMetric(validMetric.key as any);
            addToolResult({ toolCallId: toolCall.toolCallId, result: { success: true, message: `Map metric set to ${validMetric.key}` } });
          } else {
            addToolResult({
              toolCallId: toolCall.toolCallId,
              result: {
                error: `"${requested}" is not a valid metric. Valid metric keys: ${METRICS.map((m) => m.key).join(', ')}. Retry with one of those exact keys.`,
              },
            });
          }
        }
      } else if (toolCall.toolName === 'setMapFilters') {
        if (setFilters) {
          try {
            const raw = { ...((toolCall.args as any).filters || {}) };
            // Users type sale prices without the trailing zeros ("under $500" =
            // $500k). A saleMin/saleMax below 10000 is always a mis-parse — the
            // cheapest homes in Houston are far above that — so scale it up
            // deterministically instead of showing an empty map. Rents are
            // monthly and are NOT scaled.
            if (typeof raw.saleMin === 'number' && raw.saleMin > 0 && raw.saleMin < 10000) raw.saleMin *= 1000;
            if (typeof raw.saleMax === 'number' && raw.saleMax > 0 && raw.saleMax < 10000) raw.saleMax *= 1000;
            setFilters((prev: any) => ({ ...prev, ...raw }));

            // Real aggregates for the merged filters — the model answers the
            // user's question with these instead of inventing numbers.
            let stats: any = null;
            try {
              stats = getStatsForChatFilters ? getStatsForChatFilters(raw) : null;
            } catch {
              stats = null; // never block the tool result on a stats failure
            }

            // Deterministic report chain for EVERY filter request. The user
            // wants the exact sequence: filters → top areas selected → report
            // popup loads → bot answers. Models sometimes stop after the
            // filters and never make the follow-up selectMapAreas call, so the
            // client performs the whole chain here: select the top matching
            // areas, queue the report, and HOLD the tool result until the
            // popup has loaded. The interactive onboarding flow is exempt —
            // its budget filters are immediately followed by a location
            // question, and the report comes later in that flow.
            const history = [...messages];
            const lastUserIdx = history.map((m) => m.role).lastIndexOf('user');
            const prevAssistant = lastUserIdx > 0
              ? [...history.slice(0, lastUserIdx)].reverse().find((m) => m.role === 'assistant')
              : null;
            const isOnboardingAnswer = !!prevAssistant?.toolInvocations?.some(
              (t: any) => t.toolName === 'askInteractiveQuestion'
            );
            const topNames: string[] = stats?.topAreas?.length
              ? stats.topAreas.slice(0, 3).map((a: any) => a.name)
              : [];
            let reportHeld = false;
            if (!isOnboardingAnswer && topNames.length > 0 && onAreaSelect && onGenerateReport) {
              const matched = onAreaSelect(topNames, true) as string[] | null;
              if (matched && matched.length > 0) {
                reportHeld = true;
                heldToolResults.current.push({
                  toolCallId: toolCall.toolCallId,
                  result: {
                    success: true,
                    appliedFilters: raw,
                    reportQueued: true,
                    message: `Filters applied and the report finished generating for the top matching areas: ${matched.join(', ')}. Do NOT call selectMapAreas or setMapFilters again for this request. Respond with a brief, friendly confirmation of the filters and that the report is on screen. Do not stay silent.`,
                    data: stats,
                  },
                });
                // Safety net: flush on timeout so the model still answers if
                // the report never finishes.
                window.setTimeout(() => {
                  const still = heldToolResults.current.find((h) => h.toolCallId === toolCall.toolCallId);
                  if (!still) return;
                  heldToolResults.current = heldToolResults.current.filter((h) => h.toolCallId !== toolCall.toolCallId);
                  addToolResult({
                    toolCallId: still.toolCallId,
                    result: {
                      ...still.result,
                      reportQueued: false,
                      message: 'The report did not finish loading. Tell the user the report could not be generated right now and suggest trying again.',
                    },
                  });
                }, 120000);
              }
            }

            // Deterministic local answer — the model's continuation after a
            // tool call sometimes arrives empty, so the user ALWAYS sees the
            // applied filters (and the matching stats when available), the
            // same guarantee as the reportReadyMsg pattern.
            const LABELS: Record<string, string> = {
              bedsMin: 'min beds', bedsMax: 'max beds',
              bathsMin: 'min baths', bathsMax: 'max baths',
              saleMin: 'min price', saleMax: 'max price',
              rentMin: 'min rent', rentMax: 'max rent',
              sqftMin: 'min sqft', sqftMax: 'max sqft',
              yearMin: 'min year', yearMax: 'max year',
              pool: 'pool',
            };
            const applied = Object.entries(raw)
              .filter(([, v]) => v !== undefined && v !== '' && v !== 'any' && v !== 0)
              .map(([k, v]) => `${LABELS[k] || k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? v.toLocaleString() : v}`);
            let text = applied.length
              ? `✅ Done — the map now shows properties with ${applied.join(', ')}.`
              : '✅ Filters updated on the map.';
            const s = stats?.stats;
            if (s && s.count > 0) {
              text += `\n\n🏠 ${s.count.toLocaleString()} matching properties · avg price $${Math.round(s.avgSale).toLocaleString()}`;
              if (s.avgSqft) text += ` · avg ${Math.round(s.avgSqft).toLocaleString()} sqft`;
              if (stats.topAreas?.length) {
                text += `\n📍 Most in: ${stats.topAreas.slice(0, 3).map((a: any) => `${a.name} (${a.count.toLocaleString()})`).join(', ')}`;
              }
            } else if (s && s.count === 0) {
              text += '\n\n⚠️ No properties match those filters — try widening the price range.';
            }
            if (reportHeld) {
              text += '\n\n📊 Generating the report for the top matching areas — it will open on screen when ready.';
            }
            pendingFilterAnnouncement.current = { id: `filters-${toolCall.toolCallId}`, text };

            if (!reportHeld) {
              addToolResult({
                toolCallId: toolCall.toolCallId,
                result: {
                  success: true,
                  message: `Map filters updated: ${Object.entries(raw)
                    .filter(([, v]) => v !== undefined && v !== '' && v !== 'any')
                    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(', ') : v}`)
                    .join(', ') || '(none)'}. Use the "data" object (if present) to answer the user's question with REAL numbers. Do NOT invent numbers. If data is null, just confirm the filters were applied. IMPORTANT: if the user asked for a REPORT (not just to see results on the map), you MUST now call selectMapAreas with the top 1-3 area names from data.topAreas and generateReport: true — the report renders on screen automatically. Do not stop after the filters.`,
                  data: stats,
                },
              });
            }
          } catch (error) {
            console.error('[Hommie] setMapFilters failed:', error);
            addToolResult({
              toolCallId: toolCall.toolCallId,
              result: { error: 'Failed to apply filters.' },
            });
          }
        }
      }
    }
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Flush the queued filter announcement once the request has finished, so no
  // later onUpdate can wipe it (see pendingFilterAnnouncement above).
  useEffect(() => {
    if (isLoading) return;
    const pending = pendingFilterAnnouncement.current;
    if (!pending) return;
    pendingFilterAnnouncement.current = null;
    setMessages((prev) =>
      prev.some((m) => m.id === pending.id)
        ? prev
        : [...prev, { id: pending.id, role: 'assistant' as const, content: pending.text }]
    );
  }, [isLoading, messages, setMessages]);

  // Deterministic post-report moment: the parent bumps reportReadyMsg when the
  // report finishes generating. If a report tool result is being held, flush
  // it now — adding the result triggers the model's roundtrip, so its answer
  // lands right after the popup loaded (and the local announcement is skipped
  // to avoid two bubbles saying the same thing).
  useEffect(() => {
    if (!reportReadyMsg) return;
    const held = heldToolResults.current;
    if (held.length > 0) {
      heldToolResults.current = [];
      for (const h of held) {
        addToolResult({ toolCallId: h.toolCallId, result: h.result });
      }
      return;
    }
    setMessages((prev) => {
      if (prev.some((m) => m.id === `report-ready-${reportReadyMsg.id}`)) return prev;
      return [
        ...prev,
        {
          id: `report-ready-${reportReadyMsg.id}`,
          role: 'assistant' as const,
          content: reportReadyMsg.text,
        },
      ];
    });
    // addToolResult is intentionally omitted: it is NOT stable between renders
    // in @ai-sdk/react (it appears/disappears), which crashes this effect with
    // "dependency array changed size". The closure from the render that
    // re-runs this effect is the one the tool result needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportReadyMsg, setMessages]);

  const clearChat = () => {
    setMessages([greetingMessage]);
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-full shadow-2xl flex items-center justify-center text-white hover:scale-110 transition-transform z-[1000] border-2 border-white mb-[env(safe-area-inset-bottom)]"
        title="Open Hommie AI Assistant"
      >
        <Bot className="w-7 h-7" />
      </button>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 50, scale: 0.95 }}
        animate={{
          opacity: 1,
          y: 0,
          scale: 1,
          height: isMinimized ? 'auto' : 'min(600px, 70vh)'
        }}
        exit={{ opacity: 0, y: 50, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className={`fixed bottom-6 right-3 left-3 sm:left-auto w-[calc(100vw-1.5rem)] sm:w-96 bg-white/90 backdrop-blur-xl border border-white/40 shadow-2xl rounded-2xl overflow-hidden flex flex-col z-[1000] ${isMinimized ? '' : 'max-h-[80vh]'}`}
      >
        <div className="flex items-center justify-between p-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-t-2xl shadow-md">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-md border border-white/30">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-sm leading-tight">Hommie AI</h3>
              <p className="text-xs text-blue-100/80">Real Estate Assistant</p>
            </div>
          </div>
          <div className="flex items-center space-x-1">
             <button
              onClick={clearChat}
              className="p-1.5 hover:bg-white/20 rounded-md transition-colors"
              title="Clear chat"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsMinimized(!isMinimized)}
              className="p-1.5 hover:bg-white/20 rounded-md transition-colors"
              title={isMinimized ? "Expand" : "Minimize"}
            >
              {isMinimized ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1.5 hover:bg-white/20 hover:text-red-300 rounded-md transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {!isMinimized && (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/50 scroll-smooth">
              {messages.map((m) => {
                // Skip empty assistant bubbles: a tool-call-only message whose
                // final text never arrived renders as a blank white box.
                const hasInteractive = m.toolInvocations?.some(
                  (t) => t.toolName === 'askInteractiveQuestion'
                );
                if (m.role === 'assistant' && !m.content && !hasInteractive) return null;
                return (
                <div
                  key={m.id}
                  className={`flex items-start space-x-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {m.role === 'assistant' && (
                    <div className="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center shrink-0 border border-indigo-200 shadow-sm mt-1">
                      <Bot className="w-4 h-4 text-indigo-600" />
                    </div>
                  )}
                  
                  <div
                    className={`max-w-[80%] p-3 rounded-2xl shadow-sm text-sm ${
                      m.role === 'user'
                        ? 'bg-blue-600 text-white rounded-tr-none'
                        : 'bg-white border border-gray-100 text-gray-800 rounded-tl-none'
                    }`}
                  >
                    {m.content && <div className="whitespace-pre-wrap">{m.content}</div>}
                    
                    {m.toolInvocations?.map((toolInvocation) => {
                      if (toolInvocation.toolName === 'askInteractiveQuestion') {
                        return (
                          <InteractiveQuestion 
                            key={toolInvocation.toolCallId}
                            toolInvocation={toolInvocation}
                            addToolResult={addToolResult}
                          />
                        );
                      }
                      return null;
                    })}
                  </div>

                  {m.role === 'user' && (
                    <div className="w-7 h-7 bg-blue-100 rounded-full flex items-center justify-center shrink-0 border border-blue-200 shadow-sm mt-1">
                      <User className="w-4 h-4 text-blue-600" />
                    </div>
                  )}
                </div>
                );
              })}
              
              {isLoading && (
                <div className="flex items-start space-x-2 justify-start">
                  <div className="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center shrink-0 border border-indigo-200 shadow-sm mt-1">
                    <Bot className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="bg-white border border-gray-100 text-gray-800 rounded-2xl rounded-tl-none p-3 shadow-sm flex items-center space-x-1">
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"></div>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={handleSubmit} className="p-3 bg-white border-t border-gray-100">
              <div className="flex gap-2 overflow-x-auto pb-2 mb-1 scrollbar-hide">
                <button
                  type="button"
                  onClick={() => {
                    setMessages((prev) => {
                      if (prev.some((m) => m.id === 'get-started-help')) return prev;
                      return [...prev, { id: 'get-started-help', role: 'assistant' as const, content: GET_STARTED_HELP }];
                    });
                  }}
                  className="shrink-0 text-[11px] font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 px-3 py-1.5 rounded-full transition-colors whitespace-nowrap shadow-sm"
                >
                  🚀 Get Started
                </button>
                <button
                  type="button"
                  onClick={() => append({ role: 'user', content: 'Generate a report for Tomball' })}
                  className="shrink-0 text-[11px] font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
                >
                  Report for Tomball
                </button>
                <button
                  type="button"
                  onClick={() => append({ role: 'user', content: 'Compare these areas' })}
                  className="shrink-0 text-[11px] font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
                >
                  Compare Current Selection
                </button>
              </div>
              <div className="relative flex items-center">
                <input
                  type="text"
                  value={input}
                  onChange={handleInputChange}
                  placeholder="Ask about properties, areas..."
                  className="w-full pl-4 pr-12 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all text-sm text-gray-800 placeholder-gray-400"
                  disabled={isLoading}
                />
                <button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="absolute right-2 p-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors shadow-sm"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <div className="text-center mt-2">
                <span className="text-[10px] text-gray-400 font-medium tracking-wide uppercase">Powered by AI • May make mistakes</span>
              </div>
            </form>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
