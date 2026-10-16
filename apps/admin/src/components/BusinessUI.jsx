import { Check, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { registerNavigationGuard } from "../router.jsx";

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

export function Modal({ open, title, description, error = "", confirmLabel = "确定", cancelLabel = "取消", onConfirm, onCancel, danger = false }) {
  // 每个实例独立的无障碍标题 id：同屏多个弹窗（如「保存题目设置？」确认 + 「有未保存的修改」
  // 离开警告）时，可访问名称互不串扰、顶层提示可被准确定位。
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <div className={`modal-card__icon ${danger || error ? "is-danger" : ""}`}>
          {danger || error ? <WarningCircle size={26} weight="fill" /> : <Check size={24} weight="bold" />}
        </div>
        <h2 id={titleId}>{title}</h2>
        {description ? <p>{description}</p> : null}
        {error ? <p className="form-message" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button className="button button--ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className={`button ${danger || error ? "button--danger" : "button--primary"}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

// 表单确认弹窗：替代原生 window.prompt 的统一入口。
// fields: [{ name, label, type: "textarea" | "datetime-local" | "text", required, placeholder }]
// initialValues 可为字段提供初始值（如重命名时预填当前名称）。
// 必填项缺失或时间非法时禁用提交并就地提示，onConfirm(values) 由调用方执行业务请求。
// 表单确认弹窗：替代原生 window.prompt 的统一入口。
// fields: [{ name, label, type: "textarea" | "datetime-local" | "select" | "text", required, placeholder }]
// initialValues 可为字段提供初始值（如重命名时预填当前名称）。
// 必填项缺失或时间非法时禁用提交并就地提示，onConfirm(values) 由调用方执行业务请求。
// 未保存保护：弹窗内有用户改动（与 initialValues 不一致）时注册导航守卫——返回/前进、菜单、
// 刷新、退出登录都会先经统一确认；弹窗自身的取消/遮罩关闭在脏态下先弹「放弃填写内容」确认，
// 干净弹窗直接关闭（守卫是叠加的，底层编辑器的脏态由其自己的守卫拦截，互不误报）。
export function FormDialog({ open, title, description, fields = [], initialValues = null, danger = false, pending = false, error = "", confirmLabel = "确认", cancelLabel = "取消", onConfirm, onCancel }) {
  const [values, setValues] = useState({});
  const [touched, setTouched] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleId = useId();
  const discardTitleId = useId();
  useEffect(() => {
    if (open) {
      setValues(Object.fromEntries(fields.map((field) => [field.name, initialValues?.[field.name] ?? ""])));
      setTouched(false);
      setConfirmDiscard(false);
    }
    // fields 由弹窗打开时的配置决定，仅随 open 重置，避免输入过程中被覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valuesRef = useRef({});
  valuesRef.current = values;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const initialValuesRef = useRef(initialValues);
  initialValuesRef.current = initialValues;
  const openRef = useRef(open);
  openRef.current = open;
  // 脏 = 与当前弹窗的 initialValues 逐字段不一致（改动后改回原值即视为干净，不永久滞留脏态）。
  const isDirty = () => {
    if (!openRef.current) return false;
    return fieldsRef.current.some((field) => String(valuesRef.current[field.name] ?? "") !== String(initialValuesRef.current?.[field.name] ?? ""));
  };
  // 弹窗常挂载（随 open 显隐），守卫常注册；关闭时 isDirty 恒为 false，不拦截。
  useEffect(() => registerNavigationGuard(isDirty), []);
  const attemptCancel = () => {
    if (pending) return;
    if (isDirty()) { setConfirmDiscard(true); return; }
    onCancel();
  };
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
    <>
      <div className="modal-backdrop" role="presentation" onMouseDown={attemptCancel}>
        <section className="modal-card modal-card--form" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
          <div className={`modal-card__icon ${danger ? "is-danger" : ""}`}>
            {danger ? <WarningCircle size={26} weight="fill" /> : <Check size={24} weight="bold" />}
          </div>
          <h2 id={titleId}>{title}</h2>
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
            <button className="button button--ghost" disabled={pending} onClick={attemptCancel}>{cancelLabel}</button>
            <button className={`button ${danger ? "button--danger" : "button--primary"}`} disabled={pending || hasInvalid} onClick={submit}>{pending ? "处理中…" : confirmLabel}</button>
          </div>
        </section>
      </div>
      {confirmDiscard && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmDiscard(false)}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby={discardTitleId} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-card__icon is-danger"><WarningCircle size={26} weight="fill" /></div>
            <h2 id={discardTitleId}>放弃填写的内容？</h2>
            <p>关闭弹窗将丢失已填写但未提交的内容。</p>
            <div className="modal-actions">
              <button className="button button--ghost" onClick={() => setConfirmDiscard(false)}>继续填写</button>
              <button className="button button--danger" onClick={() => { setConfirmDiscard(false); onCancel(); }}>放弃内容</button>
            </div>
          </section>
        </div>
      )}
    </>
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
