import { Check, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

export function StatusBadge({ children, tone = "neutral" }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={34} weight="duotone" />}
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({ open, title, description, confirmLabel = "确定", cancelLabel = "取消", onConfirm, onCancel, danger = false }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className={`modal-card__icon ${danger ? "is-danger" : ""}`}>
          {danger ? <WarningCircle size={26} weight="fill" /> : <Check size={24} weight="bold" />}
        </div>
        <h2 id="modal-title">{title}</h2>
        {description ? <p>{description}</p> : null}
        <div className="modal-actions">
          <button className="button button--ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className={`button ${danger ? "button--danger" : "button--primary"}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

// 表单确认弹窗：替代原生 window.prompt 的统一入口。
// fields: [{ name, label, type: "textarea" | "datetime-local" | "text", required, placeholder }]
// initialValues 可为字段提供初始值（如重命名时预填当前名称）。
// 必填项缺失或时间非法时禁用提交并就地提示，onConfirm(values) 由调用方执行业务请求。
export function FormDialog({ open, title, description, fields = [], initialValues = null, danger = false, pending = false, error = "", confirmLabel = "确认", cancelLabel = "取消", onConfirm, onCancel }) {
  const [values, setValues] = useState({});
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setValues(Object.fromEntries(fields.map((field) => [field.name, initialValues?.[field.name] ?? ""])));
      setTouched(false);
    }
    // fields 由弹窗打开时的配置决定，仅随 open 重置，避免输入过程中被覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const invalid = (field) => {
    const value = String(values[field.name] || "").trim();
    if (field.required && !value) return true;
    if (field.type === "datetime-local" && value && Number.isNaN(new Date(value).getTime())) return true;
    return false;
  };
  const hasInvalid = fields.some(invalid);
  const submit = () => {
    if (hasInvalid) { setTouched(true); return; }
    onConfirm(values);
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !pending && onCancel()}>
      <section className="modal-card modal-card--form" role="dialog" aria-modal="true" aria-labelledby="form-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className={`modal-card__icon ${danger ? "is-danger" : ""}`}>
          {danger ? <WarningCircle size={26} weight="fill" /> : <Check size={24} weight="bold" />}
        </div>
        <h2 id="form-dialog-title">{title}</h2>
        {description ? <p>{description}</p> : null}
        <div className="form-dialog-fields">
          {fields.map((field) => (
            <label key={field.name} className="admin-field">
              <span>{field.label}{field.required ? "（必填）" : ""}</span>
              {field.type === "textarea"
                ? <textarea rows="3" value={values[field.name] || ""} placeholder={field.placeholder} disabled={pending} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />
                : field.type === "select"
                  ? <select value={values[field.name] || ""} disabled={pending} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}>{(field.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                  : <input type={field.type || "text"} value={values[field.name] || ""} placeholder={field.placeholder} disabled={pending} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />}
              {touched && invalid(field) ? <small className="form-dialog-error">{field.type === "datetime-local" ? "请选择有效时间" : `请填写${field.label}`}</small> : null}
            </label>
          ))}
        </div>
        {error ? <p className="form-message" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button className="button button--ghost" disabled={pending} onClick={onCancel}>{cancelLabel}</button>
          <button className={`button ${danger ? "button--danger" : "button--primary"}`} disabled={pending || hasInvalid} onClick={submit}>{pending ? "处理中…" : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

export function Toast({ toast, onClose }) {
  if (!toast) return null;
  const isError = toast.type === "error";
  return (
    <div className={`toast${isError ? " toast--error" : ""}`} role={isError ? "alert" : "status"}>
      {isError ? <WarningCircle size={18} weight="bold" /> : <Check size={18} weight="bold" />}
      <span>{toast.text}</span>
      <button aria-label="关闭提示" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

export function LoadingRows({ count = 4 }) {
  return <div className="loading-rows">{Array.from({ length: count }, (_, index) => <span key={index} />)}</div>;
}

// 页头：eyebrow 小标 + 标题 + 可选描述 + 右侧动作区（工作台各页面与数据看板共用）。
export function PageHeader({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><span>{eyebrow}</span><h1>{title}</h1>{description ? <p className="page-description">{description}</p> : null}</div>{action}</div>;
}
