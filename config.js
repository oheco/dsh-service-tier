import Schema from '@deepseek-ai/schemastery';

const labels = {
  default: { en: 'Standard', zh: '标准' },
  fast: { en: 'Fast', zh: '快速' },
  ultrafast: { en: 'Ultrafast', zh: '超快速' },
};
const mode = (tiers, description) => Schema.union(tiers.map(tier => Schema.const(tier).extra('description', labels[tier])))
  .default('default').volatile().extra('description', description);

// Validate the configuration saved by the plugin's own Client form.
export const Config = Schema.object({
  openaiDefaultMode: mode(['default', 'fast', 'ultrafast'], { en: 'OpenAI default mode', zh: 'OpenAI 默认模式' }),
  anthropicDefaultMode: mode(['default', 'fast'], { en: 'Anthropic default mode', zh: 'Anthropic 默认模式' }),
});
