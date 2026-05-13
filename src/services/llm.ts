export type Provider = 'lmstudio' | 'openrouter';

export interface LlmConfig {
  provider: Provider;
  lmStudioEndpoint: string;
  openRouterEndpoint: string;
  openRouterApiKey: string;
}

export interface GenerateOpts {
  naturalQuery: string;
  schema: string;
  taggedTables: string[];
  config: LlmConfig;
  signal?: AbortSignal;
}

const stripFences = (sql: string) => sql.replace(/```sql\n?|```\n?/g, '').trim();

const buildPrompt = (naturalQuery: string, schema: string, taggedTables: string[]) =>
  `Schema:
${schema || 'No schema loaded'}

${taggedTables.length > 0 ? `Focus on these tables: ${taggedTables.join(', ')}\n\n` : ''}Query: ${naturalQuery}

Return SQL only:`;

export async function generateSql({
  naturalQuery,
  schema,
  taggedTables,
  config,
  signal,
}: GenerateOpts): Promise<string> {
  const prompt = buildPrompt(naturalQuery, schema, taggedTables);

  let response: Response;
  if (config.provider === 'lmstudio') {
    response = await fetch(config.lmStudioEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'local-model', input: prompt, temperature: 0.1 }),
      signal,
    });
  } else {
    if (!config.openRouterApiKey.trim()) {
      throw new Error('Missing OpenRouter API key');
    }
    response = await fetch(config.openRouterEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openRouterApiKey}`,
      },
      body: JSON.stringify({
        model: 'poolside/laguna-m.1:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
      signal,
    });
  }

  if (!response.ok) {
    throw new Error(`Provider responded ${response.status}`);
  }

  const data = await response.json();
  const sql: string | undefined = config.provider === 'lmstudio'
    ? (data.content?.trim?.() ?? data.message?.trim?.())
    : data.choices?.[0]?.message?.content?.trim?.();

  if (!sql) throw new Error('No SQL returned from provider');
  return stripFences(sql);
}

export const parseTableTags = (query: string): string[] => {
  const matches = query.match(/@(\w+)/g) ?? [];
  return matches.map(tag => tag.slice(1));
};
