'use client';

import { useState, useEffect, useRef } from 'react';
import { useChat } from 'ai/react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, X, Send, Bot, User, Maximize2, Minimize2, Trash2 } from 'lucide-react';
import { BoundaryKey } from '@/lib/engine';

interface HommieChatProps {
  boundary: BoundaryKey | null;
  metricLabel: string;
  reportStats: any;
  marketHealth: any;
  selectedIds: string[];
  onAreaSelect?: (queries: string[]) => void;
  onGenerateReport?: () => void;
}

export default function HommieChat({ 
  boundary,
  metricLabel,
  reportStats,
  marketHealth,
  selectedIds,
  onAreaSelect,
  onGenerateReport
}: HommieChatProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Construct context object to send to the AI
  const contextData = {
    boundary,
    selectedAreasCount: selectedIds.length,
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
    body: {
      contextData,
    },
    initialMessages: [greetingMessage],
    onToolCall: async ({ toolCall }) => {
      if (toolCall.toolName === 'selectMapAreas') {
        const args = toolCall.args as { areasToSearch: string[]; generateReport: boolean };
        const { areasToSearch, generateReport } = args;
        
        try {
          if (onAreaSelect && areasToSearch && areasToSearch.length > 0) {
            onAreaSelect(areasToSearch);
          }
          
          if (generateReport && onGenerateReport) {
            onGenerateReport();
          }

          addToolResult({
            toolCallId: toolCall.toolCallId,
            result: { success: true, message: `Successfully matched areas and ${generateReport ? 'generated report' : 'updated selection'}.` },
          });
        } catch (error) {
          addToolResult({
            toolCallId: toolCall.toolCallId,
            result: { error: 'Failed to select areas or generate report.' },
          });
        }
      }
    }
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const clearChat = () => {
    setMessages([greetingMessage]);
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 w-14 h-14 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-full shadow-2xl flex items-center justify-center text-white hover:scale-110 transition-transform z-[1000] border-2 border-white"
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
          height: isMinimized ? 'auto' : '600px'
        }}
        exit={{ opacity: 0, y: 50, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className={`fixed bottom-6 right-6 w-96 bg-white/90 backdrop-blur-xl border border-white/40 shadow-2xl rounded-2xl overflow-hidden flex flex-col z-[1000] ${isMinimized ? '' : 'max-h-[80vh]'}`}
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
              {messages.map((m) => (
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
                    {m.content}
                  </div>

                  {m.role === 'user' && (
                    <div className="w-7 h-7 bg-blue-100 rounded-full flex items-center justify-center shrink-0 border border-blue-200 shadow-sm mt-1">
                      <User className="w-4 h-4 text-blue-600" />
                    </div>
                  )}
                </div>
              ))}
              
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
                  onClick={() => append({ role: 'user', content: 'Generate a report for these areas' })}
                  className="shrink-0 text-[11px] font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
                >
                  Generate Report
                </button>
                <button
                  type="button"
                  onClick={() => append({ role: 'user', content: 'What is the pricing trend here?' })}
                  className="shrink-0 text-[11px] font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
                >
                  Pricing Trend
                </button>
                <button
                  type="button"
                  onClick={() => append({ role: 'user', content: 'Compare these areas' })}
                  className="shrink-0 text-[11px] font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
                >
                  Compare Areas
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
