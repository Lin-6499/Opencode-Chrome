import { fail } from './native-api.mjs';

export function presentForm(form) {
  const base = { id: form.id, title: String(form.title || '需要你的回答').slice(0, 200) };
  const fields = form.fields || [];
  if (fields.length > 10 || fields.some(field => field.hidden || field.when?.length || !['string','number','integer','boolean','multiselect'].includes(field.type) || field.options?.length > 20)) return { ...base, requiresDesktop: true, fields: [] };
  const shown = fields.map(field => Object.fromEntries(['key','type','title','description','required','placeholder','default','options','custom','format','minLength','maxLength','minimum','maximum','minItems','maxItems'].filter(key => field[key] !== undefined).map(key => [key, field[key]])));
  if (JSON.stringify(shown).length > 6000) return { ...base, requiresDesktop: true, fields: [] };
  return { ...base, requiresDesktop: false, fields: shown };
}

export function validateAnswer(form, answer) {
  if (presentForm(form).requiresDesktop) fail('此交互包含复杂或隐藏字段，请在桌面端处理。');
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || JSON.stringify(answer).length > 24000) fail('回答格式无效或内容过长。');
  const fields = new Map((form.fields || []).map(field => [field.key, field]));
  for (const [key, value] of Object.entries(answer)) {
    const field = fields.get(key);
    if (!field) fail('回答中包含未知字段。');
    if (field.type === 'boolean' && typeof value !== 'boolean') fail('请选择有效的布尔值。');
    if (field.type === 'string' && typeof value !== 'string') fail('请输入文字回答。');
    if (['integer','number'].includes(field.type) && (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)))) fail('请输入有效数字。');
    if (field.type === 'multiselect' && (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string'))) fail('请选择有效的选项。');
  }
  return answer; // OpenCode performs canonical constraints/options validation.
}
