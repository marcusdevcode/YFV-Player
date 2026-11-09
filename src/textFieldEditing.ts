import type { ContextMenuItem } from "./store/contextMenuStore";

type TextField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** The text box (input or textarea) the pointer is over, or null for anything else. */
export function textFieldAt(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target;
  return null;
}

/** Cut, Copy, Paste and Select all for a text box. */
export function textFieldItems(
  field: TextField,
  label: { cut: string; copy: string; paste: string; selectAll: string },
): ContextMenuItem[] {
  const hasSelection = field.selectionStart !== field.selectionEnd;
  const editable = !field.readOnly && !field.disabled;
  return [
    { label: label.cut, disabled: !editable || !hasSelection, onSelect: () => (field.focus(), document.execCommand("cut")) },
    { label: label.copy, disabled: !hasSelection, onSelect: () => (field.focus(), document.execCommand("copy")) },
    {
      label: label.paste,
      disabled: !editable,
      onSelect: () => {
        field.focus();
        void navigator.clipboard
          .readText()
          .then((text) => document.execCommand("insertText", false, text))
          .catch(() => document.execCommand("paste"));
      },
    },
    "separator",
    { label: label.selectAll, disabled: !field.value, onSelect: () => (field.focus(), field.select()) },
  ];
}
