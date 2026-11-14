import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { errorMessage } from '@shared/errors.ts'

export const browserFormFieldsSchema = z
  .array(z.object({ ref: z.string().min(1), text: z.string() }))
  .min(1)
  .max(20)
  .superRefine((fields, context) => {
    const refs = new Set<string>()
    for (const [index, field] of fields.entries()) {
      if (refs.has(field.ref)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'ref'],
          message: 'Each field ref must be unique.',
        })
      }
      refs.add(field.ref)
    }
  })

export type BrowserFormField = z.infer<typeof browserFormFieldsSchema>[number]

interface BrowserFormContents {
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>
}

const replySchema = z.object({ ok: z.boolean(), error: z.string().optional() })

// Resolve only the current visible control. A previous snapshot may have left
// the same ref on an older, now-hidden dialog. Pin each exact node before any
// value changes so a rerender or concurrent snapshot cannot retarget the batch.
const resolveControlScript = `
  const resolveControl = (ref) => {
    const matches = Array.from(document.querySelectorAll('[data-copse-ref]')).filter((el) => {
      if (el.getAttribute('data-copse-ref') !== ref) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || style.opacity === '0' ||
          style.contentVisibility === 'hidden') return false;
      }
      return true;
    });
    if (matches.length !== 1) return null;
    const el = matches[0];
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement)) return null;
    if (el.matches(':disabled') || el.readOnly === true ||
      el.getAttribute('aria-disabled') === 'true') return null;
    if (el instanceof HTMLInputElement &&
      ['file','checkbox','radio','button','submit','reset','image','hidden'].includes(el.type)) return null;
    return el;
  };
  const valueError = (el, text) => {
    if (el instanceof HTMLSelectElement) {
      const option = Array.from(el.options).find((item) => item.value === text);
      if (!option) return 'has no matching option value';
      if (option.disabled || option.closest('optgroup[disabled]')) return 'has a disabled option';
    } else {
      const probe = document.createElement(el instanceof HTMLInputElement ? 'input' : 'textarea');
      if (el instanceof HTMLInputElement) {
        probe.type = el.type;
        for (const name of ['min', 'max', 'step', 'multiple']) {
          if (el.hasAttribute(name)) probe.setAttribute(name, el.getAttribute(name));
        }
      }
      probe.value = text;
      if (probe.value !== text) return 'does not accept that value';
    }
    return null;
  };
`

/** Enter one form under the existing browser_type permission and tab boundary. */
export async function fillBrowserForm(
  contents: BrowserFormContents,
  fields: readonly BrowserFormField[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const key = `__copseForm_${randomUUID()}`
  const completed: string[] = []
  let inFlightRef: string | undefined
  try {
    const prepared = replySchema.parse(
      await contents.executeJavaScript(
        `(() => {
          ${resolveControlScript}
          const fields = ${JSON.stringify(fields)};
          const controls = [];
          for (const field of fields) {
            const el = resolveControl(field.ref);
            if (!el) return { ok: false, error: 'Ref ' + field.ref + ' is missing, ambiguous or not editable. No fields were entered.' };
            const error = valueError(el, field.text);
            if (error) return { ok: false, error: 'Ref ' + field.ref + ' ' + error + '. No fields were entered.' };
            controls.push(el);
          }
          Object.defineProperty(globalThis, ${JSON.stringify(key)}, { value: Object.freeze(controls), configurable: true });
          return { ok: true };
        })()`,
        true,
      ),
    )
    if (!prepared.ok) throw new Error(prepared.error ?? 'The page could not prepare the form.')

    for (const [index, field] of fields.entries()) {
      signal?.throwIfAborted()
      inFlightRef = field.ref
      const result = replySchema.parse(
        await contents.executeJavaScript(
          `(() => {
            ${resolveControlScript}
            const expected = globalThis[${JSON.stringify(key)}]?.[${String(index)}];
            const el = resolveControl(${JSON.stringify(field.ref)});
            if (!el || el !== expected)
              return { ok: false, error: 'Ref ' + ${JSON.stringify(field.ref)} + ' changed while the form was being entered.' };
            el.focus();
            if (resolveControl(${JSON.stringify(field.ref)}) !== expected || valueError(el, ${JSON.stringify(field.text)}))
              return { ok: false, error: 'Ref ' + ${JSON.stringify(field.ref)} + ' changed while the form was being entered.' };
            const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype :
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value');
            if (setter && setter.set) setter.set.call(el, ${JSON.stringify(field.text)});
            else el.value = ${JSON.stringify(field.text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          })()`,
          true,
        ),
      )
      inFlightRef = undefined
      if (!result.ok) throw new Error(result.error ?? 'The page could not enter this field.')
      completed.push(field.ref)
    }
    return `Entered ${String(completed.length)} fields: ${completed.map((ref) => `[ref=${ref}]`).join(', ')}. Inspect the form before submitting it.`
  } catch (error) {
    const message =
      `Form entry stopped after ${String(completed.length)} confirmed fields of ${String(fields.length)}. ` +
      (completed.length > 0 ? `Entered: ${completed.join(', ')}. ` : '') +
      (inFlightRef ? `${inFlightRef} may already have changed. ` : '') +
      `${errorMessage(error)} Inspect the fields and refresh the snapshot before retrying; do not replay confirmed input.`
    if (signal?.aborted) throw new DOMException(message, 'AbortError')
    throw new Error(message, { cause: error })
  } finally {
    // Navigation may have destroyed the old document. These temporary node
    // references carry no permission or persistent state; never replay input
    // because best-effort cleanup could not reach that document.
    try {
      await contents.executeJavaScript(`delete globalThis[${JSON.stringify(key)}]`, false)
    } catch (error) {
      console.warn('[copse-panel] browser form reference cleanup failed:', errorMessage(error))
    }
  }
}
