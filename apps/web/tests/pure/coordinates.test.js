// C 类纯逻辑测试：utils/coordinates.js（module-contracts §5.4，新增模块，无小程序 file:line 对应）。
// 契约：wgs84ToGcj02(latitude, longitude) → { latitude, longitude }；公开 GCJ-02 偏移算法；
// 中国境外坐标原样返回（不做偏移）。用途：H5 geolocation（WGS84）→ GCJ02，等价 wx.getLocation({ type: "gcj02" })。
//
// TDD 红灯基线：apps/web/src/utils/coordinates.js 尚未实现，本文件全部用例预期因模块不存在而失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";

// 坐标参考点来源（真实可查，非凭记忆编造；抓取时间 2026-10-10）：
//
// 来源 1：googollee/eviltransform javascript/test.js 的 tests 数组（wgsLat, wgsLng, gcjLat, gcjLng）：
//   https://raw.githubusercontent.com/googollee/eviltransform/master/javascript/test.js
//     [31.1774276, 121.5272106, 31.17530398364597, 121.531541859215], // shanghai
//     [39.911954, 116.377817, 39.91334545536069, 116.38404722455657] // beijing
//
// 来源 2：wandergis/coordtransform README 示例（注意该库参数顺序为 (lng, lat)）：
//   https://raw.githubusercontent.com/wandergis/coordtransform/master/README.md
//     coordtransform.wgs84togcj02(116.404, 39.915)
//     → [ 116.41024449916938, 39.91640428150164 ]  // 即 wgs(39.915, 116.404) → gcj(39.91640428150164, 116.41024449916938)
//
// 交叉验证：两个独立来源已用 eviltransform/javascript/transform.js 的公开实现互跑核对，
// 全部 4 个期望值偏差 < 1e-6 度（远小于本套件容差 1e-4 度），两来源实现一致。
const TOLERANCE_DEGREES = 1e-4;

const assertGcj02Point = (actual, expectedLatitude, expectedLongitude, label) => {
  assert.deepEqual(
    Object.keys(actual).sort(),
    ["latitude", "longitude"],
    `${label} 返回形状应为 { latitude, longitude }`,
  );
  assert.equal(typeof actual.latitude, "number", `${label}.latitude 应为数值`);
  assert.equal(typeof actual.longitude, "number", `${label}.longitude 应为数值`);
  const deltaLatitude = Math.abs(actual.latitude - expectedLatitude);
  const deltaLongitude = Math.abs(actual.longitude - expectedLongitude);
  assert.ok(
    deltaLatitude < TOLERANCE_DEGREES,
    `${label}.latitude 偏差 ${deltaLatitude} 应小于 ${TOLERANCE_DEGREES}`,
  );
  assert.ok(
    deltaLongitude < TOLERANCE_DEGREES,
    `${label}.longitude 偏差 ${deltaLongitude} 应小于 ${TOLERANCE_DEGREES}`,
  );
};

describe("utils/coordinates.js wgs84ToGcj02（境内参考点，容差 1e-4 度）", () => {
  it("上海参考点：eviltransform test.js 向量 (31.1774276, 121.5272106) → (31.17530398364597, 121.531541859215)", async () => {
    const { wgs84ToGcj02 } = await loadSrc("utils/coordinates.js");
    const result = wgs84ToGcj02(31.1774276, 121.5272106);
    assertGcj02Point(result, 31.17530398364597, 121.531541859215, "上海参考点");
  });

  it("北京参考点：eviltransform test.js 向量 (39.911954, 116.377817) → (39.91334545536069, 116.38404722455657)", async () => {
    const { wgs84ToGcj02 } = await loadSrc("utils/coordinates.js");
    const result = wgs84ToGcj02(39.911954, 116.377817);
    assertGcj02Point(result, 39.91334545536069, 116.38404722455657, "北京参考点");
  });

  it("北京交叉来源点：wandergis/coordtransform README 向量 (39.915, 116.404) → (39.91640428150164, 116.41024449916938)", async () => {
    const { wgs84ToGcj02 } = await loadSrc("utils/coordinates.js");
    const result = wgs84ToGcj02(39.915, 116.404);
    assertGcj02Point(result, 39.91640428150164, 116.41024449916938, "北京交叉来源点");
  });
});

describe("utils/coordinates.js wgs84ToGcj02（境外坐标原样返回）", () => {
  it("纽约 (40.7128, -74.0060) 原样返回，不做偏移", async () => {
    const { wgs84ToGcj02 } = await loadSrc("utils/coordinates.js");
    const result = wgs84ToGcj02(40.7128, -74.006);
    assert.deepEqual(result, { latitude: 40.7128, longitude: -74.006 });
  });

  it("伦敦 (51.5074, -0.1278) 原样返回，不做偏移", async () => {
    const { wgs84ToGcj02 } = await loadSrc("utils/coordinates.js");
    const result = wgs84ToGcj02(51.5074, -0.1278);
    assert.deepEqual(result, { latitude: 51.5074, longitude: -0.1278 });
  });
});

describe("utils/coordinates.js wgs84ToGcj02（境内点偏移幅度与返回形状）", () => {
  it("境内点（上海）转换后两轴均发生 > 0.001 度量级的偏移，且形状为 { latitude, longitude } 数值", async () => {
    const { wgs84ToGcj02 } = await loadSrc("utils/coordinates.js");
    const wgsLatitude = 31.1774276;
    const wgsLongitude = 121.5272106;
    const result = wgs84ToGcj02(wgsLatitude, wgsLongitude);
    assert.deepEqual(Object.keys(result).sort(), ["latitude", "longitude"]);
    assert.equal(typeof result.latitude, "number");
    assert.equal(typeof result.longitude, "number");
    assert.ok(Number.isFinite(result.latitude) && Number.isFinite(result.longitude), "两轴均应为有限数值");
    assert.ok(
      Math.abs(result.latitude - wgsLatitude) > 0.001,
      `纬度偏移 ${Math.abs(result.latitude - wgsLatitude)} 应大于 0.001 度`,
    );
    assert.ok(
      Math.abs(result.longitude - wgsLongitude) > 0.001,
      `经度偏移 ${Math.abs(result.longitude - wgsLongitude)} 应大于 0.001 度`,
    );
  });
});
