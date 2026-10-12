// adapters/location.js（module-contracts §2.4）
// 平台数据面：定位层。等价 wx.getLocation({ type: "gcj02", isHighAccuracy: true })
// （pages/location/index.js:8-13；pages/task/index.js:80-81）。
//
// 语义（R25）：
// - getCurrentLocation() → Promise<{ latitude, longitude, accuracy }>
// - 返回 GCJ02 坐标：浏览器 geolocation 返回 WGS84，内部经
//   utils/coordinates.wgs84ToGcj02 转换；拒绝/失败 reject（页面层转 blocked 态）。
import { wgs84ToGcj02 } from "../utils/coordinates.js";

export function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator?.geolocation?.getCurrentPosition) {
      reject(new Error("定位服务不可用"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const converted = wgs84ToGcj02(latitude, longitude);
        resolve({ latitude: converted.latitude, longitude: converted.longitude, accuracy });
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error?.message || "定位失败"))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
