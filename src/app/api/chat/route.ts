import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';

/**
 * Flatten useChat messages into plain text history. Two reasons:
 *  1. streamText (ai 3.4.x) does NOT convert the client's useChat format
 *     (toolInvocations inside assistant messages), so tool results never
 *     reached the model — it re-called the tool in a loop.
 *  2. Sending assistant functionCall parts back to Gemini 3.x requires a
 *     `thought_signature` the old @ai-sdk/google provider doesn't capture —
 *     the API rejects the roundtrip with 400 ("missing thought_signature"),
 *     which surfaced as an empty assistant bubble in the chat.
 * Plain-text history avoids both: the tool results are delivered as a
 * "[tool result]" user message and the model answers with text.
 */
function toModelMessages(messages: any[]): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const out: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages || []) {
    if (m?.role === 'assistant' && Array.isArray(m.toolInvocations) && m.toolInvocations.length) {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      const results = m.toolInvocations
        .filter((t: any) => t && 'result' in t)
        .map((t: any) => `Tool "${t.toolName}" returned: ${JSON.stringify(t.result)}`)
        .join('\n');
      if (results) {
        out.push({
          role: 'user',
          content: `[tool result — not written by the user]\n${results}\nUse these results to answer the user's last message now. Do not call the same tool again unless the user asks for something new.`,
        });
      }
      continue;
    }
    if (m?.role === 'user' || m?.role === 'assistant' || m?.role === 'system') {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
    }
  }
  return out;
}
import { z } from 'zod';
import { AREA_ALIASES, resolveQueriesToZips } from '@/lib/areaAliases';

export async function POST(req: Request) {
  const { messages, contextData } = await req.json();

  // Pre-resolve the latest user message against the Houston-area alias map so
  // the model doesn't have to guess ZIP codes (and we don't have to rely on
  // its training-data knowledge of the Houston metro).
  const lastUserMessage =
    [...(messages || [])].reverse().find((m: any) => m.role === 'user')?.content || '';
  const tokens =
    typeof lastUserMessage === 'string'
      ? lastUserMessage.split(/[,;]\s*|\s+and\s+/i)
      : [];
  const aliasResult = resolveQueriesToZips(tokens);
  const aliasHintBlock = aliasResult.matched.length
    ? `\n\n### PRE-RESOLVED AREAS for the user's latest message\nThe user mentioned these areas which were already mapped to ZIP codes on the server. Use these ZIPs in your \`selectMapAreas\` call alongside the canonical display names so the frontend can match the right boundary features:\n${aliasResult.matched
        .map((a) => `- "${a.displayName}" → [${a.zips.join(', ')}]${a.region ? ` (${a.region})` : ''}`)
        .join('\n')}\n\nPass the union of display names AND ZIPs as the \`areasToSearch\` array (e.g. \`areasToSearch: ["Tomball", "77375", "77377"]\`). Do NOT invent ZIP codes from memory — always use the ones above.`
    : '';

  // Inject the full alias map into the system prompt so the model can also
  // resolve any area the user mentions in follow-up turns.
  const aliasContext = AREA_ALIASES.map(
    (a) => `- ${a.displayName} → ZIPs [${a.zips.join(', ')}]${a.region ? ` (${a.region})` : ''}`,
  ).join('\n');

  const systemPrompt = `
You are Hommie, a friendly, intelligent Houston real estate AI assistant.
Your primary goal is to help users understand the real estate market using the provided internal map data.

### 1. Data Source & Context
You currently have access to the following context data selected by the user on the map:
- Boundary Type: ${contextData?.boundary || 'None'}
- Selected Areas Count: ${contextData?.selectedAreasCount || 0}
- Currently Selected Area Names: ${Array.isArray(contextData?.selectedAreaNames) && contextData.selectedAreaNames.length ? contextData.selectedAreaNames.join(', ') : 'None'}
- Current Map Metric: ${contextData?.metricLabel || 'None'}

Overall Statistics for Selected Areas:
- Total Properties: ${contextData?.reportStats?.count || 0}
- Average Sale Price: ${contextData?.reportStats?.avgSale ? '$' + contextData.reportStats.avgSale.toLocaleString() : 'N/A'}
- Average Sqft: ${contextData?.reportStats?.avgSqft ? Math.round(contextData.reportStats.avgSqft).toLocaleString() + ' sqft' : 'N/A'}
- Average Days on Market: ${contextData?.reportStats?.avgDom ? Math.round(contextData.reportStats.avgDom) + ' days' : 'N/A'}
- Total Sales Volume: ${contextData?.reportStats?.totalVolume ? '$' + contextData.reportStats.totalVolume.toLocaleString() : 'N/A'}
- Average List Price: ${contextData?.reportStats?.avgList ? '$' + contextData.reportStats.avgList.toLocaleString() : 'N/A'}
- Average Lot Size: ${contextData?.reportStats?.avgLotSize ? Math.round(contextData.reportStats.avgLotSize).toLocaleString() + ' sqft' : 'N/A'}

Market Health Indicators for Selected Areas:
- Overall Score (0-100): ${contextData?.marketHealth?.score?.toFixed(1) || 'N/A'} (${contextData?.marketHealth?.label || 'N/A'})
- Months of Inventory (MOI): ${contextData?.marketHealth?.moi?.toFixed(1) || 'N/A'}
- Days on Market (DOM): ${contextData?.marketHealth?.dom?.toFixed(0) || 'N/A'}
- List-to-Sale Ratio: ${contextData?.marketHealth?.l2s ? contextData.marketHealth.l2s.toFixed(1) + '%' : 'N/A'}

### 2. Known Area Aliases (Houston metro → ZIP codes)
The internal database is indexed by ZIP code. When the user mentions a city,
suburb, or neighborhood, use this authoritative mapping to identify the right
ZIP codes. ALWAYS prefer this table over your own training-data knowledge.

${aliasContext}

When calling \`selectMapAreas\`, pass BOTH the canonical display name AND the
matching ZIP codes in the \`areasToSearch\` array so the frontend can match
either subdivisions or ZIP features. Example:
  selectMapAreas({ areasToSearch: ["Tomball", "77375", "77377"], generateReport: false })

### 3. Operating Rules
1. You may only answer questions using the authorized internal context data provided above.
2. DO NOT use external knowledge, search engines, or third-party information to supplement missing data.
3. If a question requires data you do not have in the context above, politely state that the requested information is not available in the current database.
4. If a user asks a question unrelated to real estate, decline gracefully and state you only handle real estate inquiries.
5. Provide aggregated analytics and insights. Do not dump raw data or attempt to recreate large transaction histories.
6. Distinguish between provided values and your own calculations derived from them.
7. Be concise, friendly, and professional.
8. When the user asks to see, show, or filter properties matching criteria (bedrooms, bathrooms, price, sqft, year built, pool), you MUST call \`setMapFilters\` — that data IS available as a live map filter. NEVER reply that this is unavailable. After the call, confirm in 1-2 sentences which filters were applied (e.g. "Done — the map now shows 4+ bedroom homes under $500k").

### 3a. Report Requests (CRITICAL)
When the user asks for a report, analysis, or stats for specific areas ("report for Tomball", "compare Katy and Cypress"):
- Call \`selectMapAreas\` with those areas AND \`generateReport: true\`. The report renders on screen automatically — never say you cannot generate reports.
- If the user asks to "generate the report" WITHOUT naming an area and areas are ALREADY selected (Selected Areas Count > 0), call \`selectMapAreas\` with \`areasToSearch\` set to the Currently Selected Area Names and \`generateReport: true\`.
- If the user asks for a report about CRITERIA instead of an area ("report of 4-bedroom homes under $500k", "analyze homes under $300k"), just call \`setMapFilters\` with the criteria — the client automatically selects the top matching areas and generates the report right after. Do NOT call selectMapAreas for this unless the tool result explicitly says the report is missing.
- If the user asks for a report but names NO area and NOTHING is selected, ask which area (or offer the top zones for their criteria); do not silently skip the report.

### 3b. Price Interpretation (CRITICAL)
Users almost never type full dollar amounts. When a sale price is mentioned WITHOUT a unit (k, thousand, million), it means THOUSANDS:
- "under $500" / "below 500" / "under 500k" → saleMax: 500000
- "between 300 and 600" → saleMin: 300000, saleMax: 600000
- "under $1.5 million" → saleMax: 1500000
- Rent ("rent") is monthly: "$2,000 rent" → rentMax: 2000 (rents are NOT scaled by 1000).
NEVER send a saleMin/saleMax below 10000 — the cheapest homes in Houston are far above that.

### 4. Interactive Onboarding ("Get Started" Flow)
- If the user sends a message like [GET_STARTED] or asks to "Get Started", you MUST follow this EXACT sequence of steps.
- **CRITICAL**: When you call \`askInteractiveQuestion\`, DO NOT generate ANY conversational text response. Just call the tool and stop. Do not say "Got it! Here is the next question...". The UI will handle displaying the question.

**STATE 1: Budget Selection**
- **Trigger**: User initiates the "Get Started" flow.
- **Action**: Call \`askInteractiveQuestion\` to ask for their budget.
- Example options: "Under $300k", "$300k - $500k", "$500k - $1M", "$1M+".

**STATE 2: Apply Filters and Ask Location**
- **Trigger**: User answers the budget question.
- **Action 1**: IMMEDIATELY call \`setMapFilters\` to apply their chosen budget to the map (e.g. \`maxPrice: 500000\`).
- **Action 2**: In the SAME TURN, call \`askInteractiveQuestion\` (with \`isMultiSelect: true\`) to ask which areas they are interested in.
- Example options: "Katy", "Sugar Land", "The Woodlands", "Cypress", "Pearland".

**STATE 3: Select Areas and Ask Report**
- **Trigger**: User answers the location question.
- **Action 1**: IMMEDIATELY call \`selectMapAreas\` with the areas they selected. Pass BOTH the display names AND the matching ZIPs from the alias table so the frontend can match the active boundary layer.
- **Action 2**: In the SAME TURN, call \`askInteractiveQuestion\` to ask if they want to generate a detailed report.
- Example options: "Yes, generate report", "No, just browse", "Change areas".

**STATE 4: Generate Report**
- **Trigger**: User selects "Yes, generate report".
- **Action**: Call \`selectMapAreas\` with the previously selected areas AND \`generateReport: true\`. Then, ALWAYS follow up with a brief conversational confirmation (1-2 sentences) acknowledging the report is ready and inviting the next question. Example: "Your report for Tomball is ready! Let me know if you'd like to compare it with another area or dig into any specific metric."

**General rule after any tool call**: When you call \`selectMapAreas\` (regardless of \`generateReport\`), you MUST end your turn with a short text response summarizing what you just did. Never leave the user in silence after a tool call.

### 5. Tool Capabilities
You have access to several powerful tools to control the application interface:

1. **\`selectMapAreas\`**: Use this tool ONLY when the user explicitly asks you to select, highlight, or find specific areas on the map, or asks you to generate a report for specific areas. The system will return a \`data\` object containing real-time statistics. You MUST read this data to construct your response. Pass display names AND ZIPs in \`areasToSearch\`.
2. **\`setMapBoundary\`**: Changes the Geographic Boundary. Options: 'subdivisions', 'zipcodes', 'highschools', 'elementary', 'middle', 'neighborhoods', 'areas'.
3. **\`setMapMetric\`**: Changes the active Market Metric being displayed on the map. Use one of these EXACT keys: 'Close Price', 'Price per Sqft', 'List-to-Sale Ratio', 'Days on Market', 'Est. Rental Price', 'Rent-to-Sale Ratio', 'Rental Price per Sqft', 'Rental Days On Market', 'Lot Size', 'Appreciation Rate', 'Investor Index', 'Annual HOA Fee', 'Last Year Tax Rate', 'Elem ETA Score', 'Middle ETA Score', 'High ETA Score'.
4. **\`setMapFilters\`**: Modifies the Property Filters. Uses these EXACT keys: \`saleMin\`/\`saleMax\` (sale price), \`rentMin\`/\`rentMax\` (rental price), \`bedsMin\`/\`bedsMax\`, \`bathsMin\`/\`bathsMax\`, \`sqftMin\`/\`sqftMax\`, \`yearMin\`/\`yearMax\`, \`pool\` ('any'|'yes'|'no'). Example: 4-bedroom homes under $500k → \`{ bedsMin: 4, saleMax: 500000 }\`.

When answering, reference the specific metrics provided to support your conclusions.
${aliasHintBlock}
  `.trim();

  const result = await streamText({
    // @ts-expect-error type incompatibility between ai and ai-sdk/google versions
    model: google('models/gemini-3.5-flash-lite'),
    system: systemPrompt,
    // The client sends useChat-format messages (toolInvocations live inside
    // assistant messages) — flattened to plain text so the tool results
    // actually reach the model (see toModelMessages above).
    messages: toModelMessages(messages),
    tools: {
      selectMapAreas: tool({
        description: 'Select areas on the map and optionally generate a report.',
        parameters: z.object({
          areasToSearch: z.array(z.string()).describe('An array of area names to search for and select (e.g., ["Tomball", "Sugar Land"]).'),
          generateReport: z.boolean().describe('Set to true if the user also asked to generate a report for these areas.'),
        }),
      }),
      askInteractiveQuestion: tool({
        description: 'Ask the user a multiple-choice question during the onboarding flow. This renders interactive buttons on their screen.',
        parameters: z.object({
          question: z.string().describe('The question to ask the user. Do NOT repeat this in your text response.'),
          options: z.array(z.string()).describe('An array of options for the user to choose from (e.g. ["Under $300k", "$300k - $500k", "$500k+"]).'),
          isMultiSelect: z.boolean().optional().describe('Set to true if the user should be able to select multiple options (like locations).'),
        }),
      }),
      setMapBoundary: tool({
        description: 'Changes the geographic boundary layer on the map.',
        parameters: z.object({
          boundary: z.enum(['subdivisions', 'zipcodes', 'highschools', 'elementary', 'middle', 'neighborhoods', 'areas']).describe('The new boundary layer to display.'),
        }),
      }),
      setMapMetric: tool({
        description: 'Changes the active market metric displayed on the map.',
        parameters: z.object({
          metric: z.string().describe('Exact metric key, e.g. "Close Price", "Price per Sqft", "Days on Market", "Est. Rental Price".'),
        }),
      }),
      setMapFilters: tool({
        description: 'Updates the property filters (budget, beds, baths) on the map interface.',
        parameters: z.object({
          filters: z.object({
            saleMin: z.number().optional().describe('Minimum sale price in USD.'),
            saleMax: z.number().optional().describe('Maximum sale price in USD (e.g. 500000 for "under $500k").'),
            rentMin: z.number().optional().describe('Minimum monthly rent in USD.'),
            rentMax: z.number().optional().describe('Maximum monthly rent in USD.'),
            bedsMin: z.number().optional().describe('Minimum number of bedrooms.'),
            bedsMax: z.number().optional().describe('Maximum number of bedrooms.'),
            bathsMin: z.number().optional().describe('Minimum number of bathrooms.'),
            bathsMax: z.number().optional().describe('Maximum number of bathrooms.'),
            sqftMin: z.number().optional().describe('Minimum square footage.'),
            sqftMax: z.number().optional().describe('Maximum square footage.'),
            yearMin: z.number().optional().describe('Minimum year built.'),
            yearMax: z.number().optional().describe('Maximum year built.'),
            pool: z.enum(['any', 'yes', 'no']).optional().describe('Whether the property must have a pool.'),
          }).describe('The filters to apply to the map data. Only send the keys you want to change — they are merged into the current filters. Sale prices in USD: a bare number like "under $500" means $500,000 (saleMax: 500000).'),
        }),
      }),
    },
  });

  return result.toDataStreamResponse();
}


