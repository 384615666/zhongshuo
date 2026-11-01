import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { executionConcurrencyLimitsSchema, type ExecutionConcurrencyLimits, type ExecutionConcurrencySettings } from '../../../contracts/executionConcurrency';
import { userFacingSystemText } from '../../../contracts/userFacingText';
import { command, sendCommand } from '../bridge';
import { readingNamespace } from '../data/readingPositions';
import { SettingsRow } from './SettingsRow';

const settingsSchema = z.strictObject({ revision: z.number().int().nonnegative(), limits: executionConcurrencyLimitsSchema, source: z.enum(['default', 'environment', 'saved']) });
const pendingSchema = z.strictObject({ commandId: z.string().min(8).max(128), params: z.strictObject({ expectedRevision: z.number().int().nonnegative(), limits: executionConcurrencyLimitsSchema }) });
type Pending = z.infer<typeof pendingSchema>;
type Draft = Record<keyof ExecutionConcurrencyLimits, string>;
const fields = [
  { key: 'globalMaxInFlight', label: '全局', hint: '所有项目合计' },
  { key: 'perProjectMaxInFlight', label: '每项目', hint: '每个项目的上限' },
  { key: 'perProviderMaxInFlight', label: '同渠道', hint: '同一渠道的上限' },
] as const;
const eventName = 'zs-execution-concurrency-write';
const activeWrites = new Set<string>();
const emptyDraft: Draft = { globalMaxInFlight: '', perProjectMaxInFlight: '', perProviderMaxInFlight: '' };
const asDraft = (limits: ExecutionConcurrencyLimits): Draft => ({ globalMaxInFlight: String(limits.globalMaxInFlight), perProjectMaxInFlight: String(limits.perProjectMaxInFlight), perProviderMaxInFlight: String(limits.perProviderMaxInFlight) });
const sameLimits = (a: ExecutionConcurrencyLimits, b: ExecutionConcurrencyLimits) => fields.every(f => a[f.key] === b[f.key]);
function storedRequest(key: string): Pending | null {
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  if (raw.length > 2048) throw Error('待确认的设置记录无法读取，请重新打开设置。');
  return pendingSchema.parse(JSON.parse(raw));
}

export function ExecutionConcurrencyPanel({ readOnly = false }: { readOnly?: boolean }) {
  const namespace = readingNamespace();
  const storageKey = namespace ? namespace.replace('zs.hifi.reading.', 'zs.hifi.executionConcurrency.') : null;
  const [facts, setFacts] = useState<ExecutionConcurrencySettings | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [canRead, setCanRead] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const isCurrent = useCallback(() => mounted.current && readingNamespace() === namespace, [namespace]);

  const read = useCallback(async (preserveDraft = false) => {
    const ticket = ++generation.current;
    setLoading(true);
    try {
      if (!storageKey) throw Error('正在确认数据位置，请稍后重新读取。');
      const request = storedRequest(storageKey);
      const value = settingsSchema.parse(await command<ExecutionConcurrencySettings>('app.executionConcurrency.get', {}));
      if (!isCurrent() || ticket !== generation.current) return false;
      setFacts(value); setCanRead(true); setPending(request); setSaving(activeWrites.has(storageKey));
      if (!preserveDraft) setDraft(asDraft(request?.params.limits ?? value.limits));
      setError(request ? '上次保存结果尚未确认，请使用原请求重试。' : null);
      return true;
    } catch (e) {
      if (!isCurrent() || ticket !== generation.current) return false;
      setCanRead(false); setError(userFacingSystemText((e as Error).message));
      return false;
    } finally { if (isCurrent() && ticket === generation.current) setLoading(false); }
  }, [storageKey, isCurrent]);

  useEffect(() => {
    mounted.current = true;
    void read();
    const onSettled = () => { if (isCurrent()) void read(); };
    window.addEventListener(eventName, onSettled);
    return () => { mounted.current = false; generation.current++; window.removeEventListener(eventName, onSettled); };
  }, [read, isCurrent]);

  const submit = async (retry = false) => {
    if (!storageKey || !isCurrent() || readOnly || localOnly || loading || !canRead || !facts || activeWrites.has(storageKey)) return;
    let request = pending;
    if (!retry) {
      if (pending) return;
      const invalid = fields.find(f => !/^\d+$/.test(draft[f.key].trim()) || Number(draft[f.key]) < 1 || Number(draft[f.key]) > 32);
      if (invalid) {
        setError('三项上限都需填写 1–32 的整数。');
        form.current?.querySelector<HTMLInputElement>(`[name="${invalid.key}"]`)?.focus();
        return;
      }
      const limits = executionConcurrencyLimitsSchema.parse(Object.fromEntries(fields.map(f => [f.key, Number(draft[f.key])]))) as ExecutionConcurrencyLimits;
      if (sameLimits(limits, facts.limits)) return;
      request = { commandId: `execution-concurrency-${crypto.randomUUID()}`, params: { expectedRevision: facts.revision, limits } };
    }
    if (!request) return;
    try { localStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('无法保留待确认的设置，本次尚未提交。请重新打开后重试。'); return; }
    activeWrites.add(storageKey); setSaving(true); setPending(request); setError(null); setSaved(false);
    // Invalidate reads started before this write; a late read cannot re-enable inputs.
    generation.current++;
    try {
      const result = await sendCommand<ExecutionConcurrencySettings>(request.commandId, 'app.executionConcurrency.set', request.params);
      if (result.status === 'unknown') {
        if (isCurrent()) setError('保存结果尚未确认，请使用原请求重试。');
        return;
      }
      localStorage.removeItem(storageKey);
      if (!isCurrent()) return;
      setPending(null);
      if (result.status === 'failed') {
        if (result.code === 'FORBIDDEN' || result.code === 'PERMISSION_DENIED') setLocalOnly(true);
        const refreshed = await read(true);
        if (isCurrent()) setError(result.code === 'STALE_REVISION' ? refreshed ? '其他窗口已更改设置，已读取最新上限。请核对后再次保存。' : '其他窗口已更改设置，但读取最新上限失败。请重新读取后保存。' : userFacingSystemText(result.error));
        return;
      }
      const receipt = settingsSchema.parse(result.data);
      let value: ExecutionConcurrencySettings;
      try { value = settingsSchema.parse(await command<ExecutionConcurrencySettings>('app.executionConcurrency.get', {})); }
      catch {
        if (isCurrent()) { setCanRead(false); setError('已收到保存回执，但读取当前上限失败。请重新读取确认。'); }
        return;
      }
      if (!isCurrent()) return;
      setFacts(value); setDraft(asDraft(value.limits)); setCanRead(true);
      if (value.revision < receipt.revision || !sameLimits(value.limits, request.params.limits)) setError('保存后的设置已变化，请核对当前上限。');
      else { setError(null); setSaved(true); }
    } catch (e) {
      // If local receipt cleanup failed, retain the exact original request.
      if (isCurrent()) { setPending(request); setError(`设置结果未能确认：${userFacingSystemText((e as Error).message)}。请使用原请求重试。`); }
    } finally {
      activeWrites.delete(storageKey);
      if (isCurrent()) setSaving(false);
      // A page opened while this request was in flight must read the new facts.
      if (!isCurrent()) window.dispatchEvent(new Event(eventName));
    }
  };

  const disabled = loading || saving || pending != null || !canRead || readOnly || localOnly;
  const changed = facts != null && fields.some(f => draft[f.key] !== String(facts.limits[f.key]));
  return <section className="card" style={{ marginTop: 14, marginBottom: 14 }} data-settings-row="execution-concurrency" aria-label="同时运行的 AI" aria-busy={loading || saving}>
    <form ref={form} noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="pset-row">
        <div className="pset-row-label">
          <div className="pset-row-name">同时运行的 AI</div>
          <div className="pset-row-hint">超出上限的任务会等待；调低不会中断正在运行的任务。</div>
          {facts ? <div className="small faint" data-zs-execution-current>当前上限：全局 {facts.limits.globalMaxInFlight} · 每项目 {facts.limits.perProjectMaxInFlight} · 同渠道 {facts.limits.perProviderMaxInFlight}{facts.source === 'environment' ? '（来自启动设置）' : facts.source === 'default' ? '（默认）' : ''}</div> : <div className="small faint">{loading ? '读取中…' : '尚未确认当前上限'}</div>}
        </div>
      </div>
      {fields.map(field => <SettingsRow key={field.key} label={field.label} hint={field.hint} control={<input className="input pset-number" type="number" inputMode="numeric" name={field.key} aria-label={`${field.label}同时运行上限`} min={1} max={32} step={1} value={draft[field.key]} disabled={disabled} onChange={e => { setDraft(current => ({ ...current, [field.key]: e.target.value })); setSaved(false); }} />} />)}
      <div className="small faint" style={{ lineHeight: 1.7, marginTop: 8 }}>同一成员在同一对话串中仍依次执行；有前后依赖或未解除保护的任务会等待。同串不同成员若需同时修改文件，还要在项目设置中选择「允许成员并行」。</div>
      {error ? <div className="pset-row-error" role="alert">{error}</div> : null}
      {(readOnly || localOnly) ? <div className="small faint">仅可在本机修改。</div> : null}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        {pending ? <button className="btn primary sm" type="button" disabled={saving || loading || !canRead || readOnly || localOnly} onClick={() => { void submit(true); }}>使用原请求重试</button>
          : <button className="btn primary sm" type="submit" disabled={disabled || !changed}>保存并发设置</button>}
        <button className="btn sm" type="button" disabled={saving || loading || pending != null} onClick={() => { setSaved(false); void read(); }}>重新读取</button>
        <span className="small faint" role="status">{saving ? '正在保存并核对…' : saved ? '已保存' : ''}</span>
      </div>
    </form>
  </section>;
}
