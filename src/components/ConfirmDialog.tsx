import type { ReactNode } from "react";
import { useT } from "../translate";

/** A small modal with a message and two buttons. */
export default function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div className="modal-backdrop" onClick={props.onCancel}>
      <div className="modal" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        <div className="modal-body">{props.children}</div>
        <div className="modal-actions">
          <button onClick={props.onCancel}>{t("common.cancel")}</button>
          <button className={props.danger ? "danger" : "primary"} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
