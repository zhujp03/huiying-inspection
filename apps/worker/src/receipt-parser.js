// 确定性小票解析器：只按规则提取候选，绝不猜测。
// 支持：
//   A. name <数量>x <单价> <行总价>   （两金额行；x1 与 1x 两种写法）
//   B. name <数量>x <行总价>          （单金额行：以行总价为准，单价可整除时推算）
//   C. name <行总价>                 （无数量行：数量视为 1，单价=行总价）
//   D. 跨行合并：name / xN amount     （OCR 把菜名与数量金额拆成相邻两行时合并）
// 汇总词（小计/合计/折扣/优惠/服务费/实付/支付/抹零）绝不产生菜品候选。
const cents = (value) => {
  const normalized = value.replace(/[￥¥,\s]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
};

const AMOUNT = "[￥¥]?\\d+(?:\\.\\d{1,2})?";
// 数量写法：x1 / 1x / x 1 / 1 x
const quantityGroup = "(?:(\\d{1,3})\\s*[x×]|[x×]\\s*(\\d{1,3}))";
const twoAmount = new RegExp(`^(.+?)\\s+${quantityGroup}\\s*(${AMOUNT})\\s+(${AMOUNT})$`, "i");
const oneAmount = new RegExp(`^(.+?)\\s+${quantityGroup}\\s*(${AMOUNT})$`, "i");
const plainAmount = new RegExp(`^(.+?)\\s+(${AMOUNT})$`);
const quantityOnly = /^[x×]?\s*\d{1,3}$/;
const summaryWords = /(?:合计|小计|折扣|优惠|服务费|实付|实收|应收|应付|找零|抹零|支付|微信|支付宝)/;

const resolveQuantity = (match) => Number(match[2] !== undefined ? match[2] : match[3]);

const pushCandidate = (candidates, { name, quantity, unitPriceCents, lineTotalCents, sourceText, confidence, boundingBox }) => {
  const rawName = name.trim();
  if (!rawName || quantityOnly.test(rawName) || summaryWords.test(rawName)) return;
  candidates.push({
    rawName, normalizedName: rawName.normalize("NFC"), quantity,
    unitPriceCents, lineTotalCents, sourceText,
    confidence: Number(confidence || 0), boundingBox: boundingBox || [],
  });
};

export function parseReceiptLines(lines) {
  const candidates = [];
  const rows = lines.map((line) => ({ text: String(line.text || "").trim(), confidence: line.confidence, boundingBox: line.boundingBox }));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const text = row.text;
    if (!text) continue;

    // D. 跨行合并：上一行是“只有文字没有金额”的菜名，本行以数量/金额开头。
    if (index > 0) {
      const previous = rows[index - 1];
      const mergedName = /^(?:\d{1,3}\s*[x×]|[x×]\s*\d{1,3})/.test(text) && previous.text && !summaryWords.test(previous.text)
        ? previous.text
        : null;
      if (mergedName) {
        const combined = `${mergedName} ${text}`;
        const mergedTwo = combined.match(twoAmount);
        const mergedOne = mergedTwo ? null : combined.match(oneAmount);
        if (mergedTwo) {
          pushCandidate(candidates, { name: mergedTwo[1], quantity: resolveQuantity(mergedTwo), unitPriceCents: cents(mergedTwo[4]), lineTotalCents: cents(mergedTwo[5]), sourceText: combined, ...row });
          continue;
        }
        if (mergedOne) {
          const lineTotalCents = cents(mergedOne[4]);
          const quantity = resolveQuantity(mergedOne);
          pushCandidate(candidates, { name: mergedOne[1], quantity, unitPriceCents: quantity > 0 && lineTotalCents % quantity === 0 ? lineTotalCents / quantity : null, lineTotalCents, sourceText: combined, ...row });
          continue;
        }
      }
    }

    // A. 两金额行：name <数量>x <单价> <行总价>
    const two = text.match(twoAmount);
    if (two) {
      pushCandidate(candidates, { name: two[1], quantity: resolveQuantity(two), unitPriceCents: cents(two[4]), lineTotalCents: cents(two[5]), sourceText: text, ...row });
      continue;
    }
    // B. 单金额行：name <数量>x <行总价>（单价=行总价/数量，仅当整除为整数分时推算）
    const one = text.match(oneAmount);
    if (one) {
      const lineTotalCents = cents(one[4]);
      const quantity = resolveQuantity(one);
      pushCandidate(candidates, { name: one[1], quantity, unitPriceCents: quantity > 0 && lineTotalCents % quantity === 0 ? lineTotalCents / quantity : null, lineTotalCents, sourceText: text, ...row });
      continue;
    }
    // C. 无数量行：name lineTotal（数量视为 1，单价=行总价）
    const plain = text.match(plainAmount);
    if (plain) {
      const lineTotalCents = cents(plain[2]);
      pushCandidate(candidates, { name: plain[1], quantity: 1, unitPriceCents: lineTotalCents, lineTotalCents, sourceText: text, ...row });
      continue;
    }
  }
  return candidates;
}
