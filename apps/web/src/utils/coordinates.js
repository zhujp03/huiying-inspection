// utils/coordinates.js（module-contracts §5.4；H5 新增平台差异模块）
//
// 语义（R25 定位采集语义的 GCJ02 要求）：
// - wgs84ToGcj02(latitude, longitude) → { latitude, longitude }
// - 公开 GCJ-02 偏移算法（克拉索夫斯基椭球：a=6378245、第一偏心率平方
//   ee=0.00669342162296594323）；中国境外坐标原样返回（不做偏移）。
// - 小程序由 wx.getLocation({ type: "gcj02" }) 系统完成转换；H5 浏览器 geolocation
//   返回 WGS84，需本模块转换。

const PI = Math.PI;
const SEMI_MAJOR_AXIS = 6378245;
const FIRST_ECCENTRICITY_SQUARED = 0.00669342162296594323;

// 中国境外粗判边界（GCJ-02 算法公开惯例口径）。
function outOfChina(latitude, longitude) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

function transformLatitude(x, y) {
  let result = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  result += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  result += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  result += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return result;
}

function transformLongitude(x, y) {
  let result = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  result += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  result += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  result += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return result;
}

export function wgs84ToGcj02(latitude, longitude) {
  if (outOfChina(latitude, longitude)) return { latitude, longitude };
  let deltaLatitude = transformLatitude(longitude - 105.0, latitude - 35.0);
  let deltaLongitude = transformLongitude(longitude - 105.0, latitude - 35.0);
  const radLatitude = (latitude / 180.0) * PI;
  let magic = Math.sin(radLatitude);
  magic = 1 - FIRST_ECCENTRICITY_SQUARED * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  deltaLatitude = (deltaLatitude * 180.0) / (((SEMI_MAJOR_AXIS * (1 - FIRST_ECCENTRICITY_SQUARED)) / (magic * sqrtMagic)) * PI);
  deltaLongitude = (deltaLongitude * 180.0) / ((SEMI_MAJOR_AXIS / sqrtMagic) * Math.cos(radLatitude) * PI);
  return { latitude: latitude + deltaLatitude, longitude: longitude + deltaLongitude };
}
