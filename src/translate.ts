import { useCallback } from "react";
import { DEFAULT_LANGUAGE, LOCALES, type PluralKey, type TKey } from "./locales";
import { useInterfaceStore } from "./store/interfaceStore";

type Vars = Record<string, string | number>;

const fill = (text: string, vars?: Vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text;

const pick = (language: string, key: string): string | undefined =>
  LOCALES[language]?.strings?.[key] ?? LOCALES[DEFAULT_LANGUAGE].strings?.[key];

/** The text for `key` in `language` (English when that language lacks it), with {vars} filled in. */
export function translate(language: string, key: TKey, vars?: Vars): string {
  return fill(pick(language, key) ?? key, vars);
}

/** A text with a key that is not in en.json (theme color/icon names come from the registry): the English fallback is used when the language lacks it. */
export const translateOr = (language: string, key: string, fallback: string): string =>
  LOCALES[language]?.strings?.[key] ?? fallback;

/** A text with plural forms: `<base>.one` / `.two` / `.few` / `.many` / `.other`, by the language's rules. */
export function translatePlural(language: string, base: PluralKey, count: number, vars?: Vars): string {
  let category = "other";
  try {
    category = new Intl.PluralRules(language).select(count);
  } catch {
    /* unknown language tag: use "other" */
  }
  const text = pick(language, `${base}.${category}`) ?? pick(language, `${base}.other`) ?? base;
  return fill(text, { count, ...vars });
}

/** For code outside components (notices, dialogs): uses the language that is selected right now. */
export const tr = (key: TKey, vars?: Vars) => translate(useInterfaceStore.getState().language, key, vars);
export const trn = (base: PluralKey, count: number, vars?: Vars) =>
  translatePlural(useInterfaceStore.getState().language, base, count, vars);

/** For components: `t` and `tn` re-render the component when the language changes. */
export function useT() {
  const language = useInterfaceStore((s) => s.language);
  const t = useCallback((key: TKey, vars?: Vars) => translate(language, key, vars), [language]);
  const tn = useCallback((base: PluralKey, count: number, vars?: Vars) => translatePlural(language, base, count, vars), [language]);
  const td = useCallback((key: string, fallback: string) => translateOr(language, key, fallback), [language]);
  return { t, tn, td, language };
}
