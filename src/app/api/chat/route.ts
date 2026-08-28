import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
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
2. **\`setMapBoundary\`**: Changes the Geographic Boundary. Options: 'subdivisions', 'zipcodes', 'counties', 'cities', 'school_districts'.
3. **\`setMapMetric\`**: Changes the active Market Metric being displayed on the map (e.g., 'Close Price', 'DOM', 'MOI').
4. **\`setMapFilters\`**: Modifies the Property Filters. Uses these EXACT keys: \`saleMin\`/\`saleMax\` (sale price), \`rentMin\`/\`rentMax\` (rental price), \`bedsMin\`/\`bedsMax\`, \`bathsMin\`/\`bathsMax\`, \`sqftMin\`/\`sqftMax\`, \`yearMin\`/\`yearMax\`, \`pool\` ('any'|'yes'|'no'). Example: 4-bedroom homes under $500k → \`{ bedsMin: 4, saleMax: 500000 }\`.

When answering, reference the specific metrics provided to support your conclusions.
${aliasHintBlock}
  `.trim();

  const result = await streamText({
    // @ts-expect-error type incompatibility between ai and ai-sdk/google versions
    model: google('models/gemini-3.5-flash-lite'),
    system: systemPrompt,
    messages,
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
          boundary: z.enum(['subdivisions', 'zipcodes', 'counties', 'cities', 'school_districts']).describe('The new boundary layer to display.'),
        }),
      }),
      setMapMetric: tool({
        description: 'Changes the active market metric displayed on the map.',
        parameters: z.object({
          metric: z.string().describe('The name of the metric to display (e.g. "Close Price", "DOM", "MOI").'),
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
          }).describe('The filters to apply to the map data. Only send the keys you want to change — they are merged into the current filters.'),
        }),
      }),
    },
  });

  return result.toDataStreamResponse();
}


