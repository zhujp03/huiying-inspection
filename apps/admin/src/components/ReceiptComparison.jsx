function money(cents) {
  if (cents === null || cents === undefined) return "未识别";
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}¥${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function flags(dish) {
  return [
    dish.source === "ocr" && "来自小票",
    dish.reviewFields?.length > 0 && "识别时待核对",
    dish.priceDerived && "系统推算",
    dish.manuallyModified && "已人工修改",
    dish.removed && "未保留到最终菜品",
    dish.source === "manual" && "人工新增",
  ].filter(Boolean);
}

function DishTable({ title, rows }) {
  return <div className="comparison-column"><header><h3>{title}</h3></header><div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>菜品</th><th>数量</th><th>单价</th><th>行总价</th><th>记录标记</th></tr></thead><tbody>{rows.map((dish, index) => <tr key={dish.id || `${dish.name}-${index}`} className={dish.removed ? "is-removed" : ""}><td><strong>{dish.name}</strong></td><td>{dish.quantity ?? "—"}</td><td>{money(dish.unitPriceCents)}</td><td>{money(dish.lineTotalCents)}</td><td><div className="comparison-flags">{flags(dish).map((flag) => <span key={flag}>{flag}</span>)}</div></td></tr>)}</tbody></table></div></div>;
}

export function ReceiptComparison({ comparison }) {
  if (!comparison) return null;
  return <section className="panel receipt-comparison" aria-label="消费小票与最终菜品比对">
    <div className="panel-heading"><div><h2>消费小票与最终菜品比对</h2></div><span className="readonly-badge">已锁定</span></div>
    <div className="receipt-thumbnail-list">{comparison.receipts.map((receipt, index) => receipt.thumbnailUrl ? <a key={receipt.id} href={receipt.previewUrl || undefined} target="_blank" rel="noreferrer" aria-label={`查看第 ${index + 1} 张消费小票原图`}><img src={receipt.thumbnailUrl} alt={`第 ${index + 1} 张消费小票缩略图`} /><span>第 {index + 1} 张</span><small>查看短时原图</small></a> : <div key={receipt.id} className="receipt-thumbnail-unavailable"><span>第 {index + 1} 张</span><small>{receipt.previewStatus === "restoring" ? "归档恢复中" : "原图暂不可用"}</small></div>)}</div>
    <div className="receipt-total-strip"><div><span>小票识别总额</span><strong>{money(comparison.receiptTotals.recognizedCents)}</strong></div><div><span>最终菜品总额</span><strong>{money(comparison.receiptTotals.finalCents)}</strong></div><div><span>金额差异</span><strong>{money(comparison.receiptTotals.differenceCents)}</strong></div></div>
    <div className="comparison-grid"><DishTable title="小票识别原始结果" rows={comparison.ocrCandidates} /><DishTable title="探店员最终菜品" rows={comparison.finalDishes} /></div>
    <div className="difference-list"><h3>差异说明</h3>{comparison.differences.length ? comparison.differences.map((difference, index) => <article key={`${difference.kind}-${index}`}><strong>{difference.label}</strong><span>{difference.candidateName || "小票未识别"} → {difference.finalName || "最终未保留"}</span>{difference.amountDifferenceCents !== null && difference.amountDifferenceCents !== undefined && <small>金额差异 {money(difference.amountDifferenceCents)}</small>}</article>) : <p>小票识别与最终填写没有差异</p>}</div>
  </section>;
}
