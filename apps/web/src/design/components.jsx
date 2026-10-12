// 汇盈探店 · 探员端 H5 设计系统组件（骨架阶段）。
// 结构与视觉契约：docs/web/design.md §3；样式全部来自 src/design/base.css，组件内不写内联样式。
// 阶段说明：本阶段只交付「结构与状态位」，不承载业务逻辑——数据一律经 props 注入，
// 交互回调一律由页面透传（第 3 段实现时接线）。
import React from "react";

/* ---------- 通用 ---------- */

export function Card({ flush = false, gapless = false, className = "", style, onClick, children }) {
  const cls = ["card", flush ? "card--flush" : "", gapless ? "card--gapless" : "", className].filter(Boolean).join(" ");
  return (
    <div className={cls} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

export function SectionHeading({ children }) {
  return <span className="section-heading">{children}</span>;
}

export function Eyebrow({ children }) {
  return <span className="eyebrow">{children}</span>;
}

export function Muted({ children }) {
  return <span className="muted">{children}</span>;
}

/* ---------- 按钮（primary / outline / secondary / link / danger） ---------- */

export function Button({
  variant = "primary", // primary | outline | secondary | link | danger
  block = false,
  small = false,
  disabled = false,
  onClick,
  children,
  ...rest
}) {
  const cls = ["btn", `btn--${variant}`, block ? "btn--block" : "", small ? "btn--sm" : ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/* ---------- 表单 ---------- */

export function Field({ label, required = false, error, children }) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? <span className="required">*</span> : null}
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  onFocus,
  onBlur,
  placeholder,
  type = "text",
  maxLength,
  error = false,
  focusMark = false,
  ...rest
}) {
  const cls = ["input", error ? "input--error" : "", focusMark ? "input--focus" : ""].filter(Boolean).join(" ");
  return (
    <input
      className={cls}
      type={type}
      value={value}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder={placeholder}
      maxLength={maxLength}
      {...rest}
    />
  );
}

export function PasswordInput({ value, onChange, onFocus, onBlur, placeholder, showPassword, onTogglePassword, error = false, focusMark = false }) {
  return (
    <span className="input-wrap">
      <TextInput
        type={showPassword ? "text" : "password"}
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        error={error}
        focusMark={focusMark}
      />
      <button type="button" className="input-eye" onClick={onTogglePassword} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
        {showPassword ? "隐藏" : "显示"}
      </button>
    </span>
  );
}

export function TextArea({ value, onChange, placeholder, error = false, id, ...rest }) {
  const cls = ["textarea", error ? "textarea--error" : ""].filter(Boolean).join(" ");
  return <textarea id={id} className={cls} value={value} onChange={onChange} placeholder={placeholder} {...rest} />;
}

/* ---------- 状态徽标（五 tone，对齐小程序 status-badge） ---------- */

export function StatusBadge({ tone = "muted", children }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

/* ---------- 骨架屏 ---------- */

export function Skeleton({ variant = "line", className = "" }) {
  return <div className={`skeleton skeleton--${variant} ${className}`.trim()} />;
}

/* ---------- 空态 ---------- */

export function EmptyState({ title, desc, action }) {
  return (
    <div className="empty-state">
      <span className="empty-title">{title}</span>
      {desc ? <span className="empty-desc">{desc}</span> : null}
      {action}
    </div>
  );
}

/* ---------- 错误态（阻断型，含重试） ---------- */

export function ErrorState({ title = "暂时无法加载", message, onRetry, retryLabel = "重新加载", secondary }) {
  return (
    <div className="error-state">
      <span className="error-title">{title}</span>
      {message ? <span className="inline-error">{message}</span> : null}
      {onRetry ? (
        <Button variant="primary" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
      {secondary}
    </div>
  );
}

/* ---------- 非阻塞错误条（有内容时的降级提示 + 重试入口） ---------- */

export function ErrorBar({ message, onRetry }) {
  return (
    <div className="error-bar" role="status">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="error-bar__retry" onClick={onRetry}>
          重试
        </button>
        ) : null}
    </div>
  );
}

/* ---------- Toast（骨架态：静态结构 + 显隐 class 位） ---------- */

export function Toast({ message = "", visible = false }) {
  return (
    <div className={`toast ${visible ? "toast--visible" : "toast--hidden"}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

/* ---------- 底部三 Tab 导航（首页/日程/我的） ---------- */

const TAB_ITEMS = [
  { name: "home", route: "/home", text: "首页", icon: "◎" },
  { name: "schedule", route: "/schedule", text: "日程", icon: "▤" },
  { name: "profile", route: "/profile", text: "我的", icon: "◍" },
];

export function TabBar({ active, onNavigate }) {
  return (
    <nav className="tabbar">
      <div className="tabbar__list">
        {TAB_ITEMS.map((tab) => (
          <a
            key={tab.name}
            href={`#${tab.route}`}
            className={`tabbar__item ${active === tab.name ? "tabbar__item--active" : ""}`}
            onClick={(event) => {
              event.preventDefault();
              onNavigate?.(tab.route);
            }}
          >
            <span className="tabbar__icon" aria-hidden="true">
              {tab.icon}
            </span>
            <span>{tab.text}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}

/* ---------- 页面顶部导航（非 tab 页） ---------- */

export function PageNav({ title, onBack, right }) {
  return (
    <header className="page-nav">
      {onBack ? (
        <button type="button" className="page-nav__back" onClick={onBack} aria-label="返回">
          ‹
        </button>
      ) : (
        <span className="page-nav__spacer" />
      )}
      <span className="page-nav__title">{title}</span>
      {right || <span className="page-nav__spacer" />}
    </header>
  );
}

/* ---------- 三步流程条（答题 → 菜品与小票 → 其他记录） ---------- */

const FLOW_STEPS = [
  { key: "survey", label: "答题" },
  { key: "dishes", label: "菜品与小票" },
  { key: "other", label: "其他记录" },
];

export function FlowSteps({ current }) {
  const currentIndex = FLOW_STEPS.findIndex((step) => step.key === current);
  return (
    <div className="flow-steps">
      {FLOW_STEPS.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "active" : "";
        return (
          <React.Fragment key={step.key}>
            {index > 0 ? <span className={`flow-step__bar ${index <= currentIndex ? "flow-step__bar--done" : ""}`} /> : null}
            <span className={`flow-step ${state ? `flow-step--${state}` : ""}`}>
              <span className="flow-step__num">{index + 1}</span>
              <span className="flow-step__label">{step.label}</span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ---------- 筛选 chips（日程页） ---------- */

export function FilterChips({ chips, onselect }) {
  return (
    <div className="filter-chips">
      {chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          className={`chip ${chip.active ? "chip--active" : ""}`}
          onClick={() => onselect?.(chip.value)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- 列表行（入口行/帮助块） ---------- */

export function ListRow({ label, onClick, children }) {
  return (
    <button type="button" className="list-row" onClick={onClick}>
      <span className="list-row__label">{label}</span>
      {children ?? <span className="list-chevron" aria-hidden="true">›</span>}
    </button>
  );
}

/* ---------- 提示条 ---------- */

export function NoticeBar({ children }) {
  return <div className="notice-bar">{children}</div>;
}
