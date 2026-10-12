import { useEffect, useRef, useState } from "react";
import { MapPin, MagnifyingGlass } from "@phosphor-icons/react";

let mapLoader;
function loadTencentMap(key) {
  if (window.TMap) return Promise.resolve(window.TMap);
  if (!key) return Promise.reject(new Error("地图服务尚未配置，请联系管理员"));
  if (!mapLoader) mapLoader = new Promise((resolve, reject) => {
    const callback = `jundeMapReady${Date.now()}`;
    window[callback] = () => { delete window[callback]; resolve(window.TMap); };
    const script = document.createElement("script");
    script.src = `https://map.qq.com/api/gljs?v=1.exp&key=${encodeURIComponent(key)}&libraries=service&callback=${callback}`;
    script.onerror = () => reject(new Error("地图加载失败，请检查网络后重试"));
    document.head.append(script);
  });
  return mapLoader;
}

export function TencentStoreMap({ value, radiusMeters, onChange }) {
  const container = useRef(null);
  const runtime = useRef(null);
  const [status, setStatus] = useState("正在加载地图…");
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const key = import.meta.env.VITE_TENCENT_MAP_KEY;

  useEffect(() => {
    let active = true;
    loadTencentMap(key).then((TMap) => {
      if (!active || !container.current) return;
      // 新建门店默认定位到昆明（业务门店主要分布区域）；编辑已有门店时定位到该店。
      const center = new TMap.LatLng(value.latitude || 25.0389, value.longitude || 102.7183);
      const map = new TMap.Map(container.current, { center, zoom: value.latitude ? 17 : 12 });
      const marker = new TMap.MultiMarker({ map, geometries: [{ id: "store", position: center }] });
      const circle = new TMap.MultiCircle({ map, styles: { range: new TMap.CircleStyle({ color: "rgba(255,104,72,.18)", showBorder: true, borderColor: "#ff6848", borderWidth: 2 }) }, geometries: [{ id: "range", styleId: "range", center, radius: radiusMeters }] });
      // 全国搜索：不启用 regionFix，搜索请求不携带地图中心位置，结果不再被当前地图范围限制。
      runtime.current = { TMap, map, marker, circle, center, suggestion: new TMap.service.Suggestion({ pageSize: 8 }) };
      map.on("idle", () => { runtime.current.center = map.getCenter(); });
      setStatus("拖动地图后可使用中心位置校准门店坐标");
    }).catch((error) => { if (active) setStatus(error.message); });
    return () => { active = false; runtime.current?.map?.destroy?.(); runtime.current = null; };
  }, [key]);

  useEffect(() => {
    const current = runtime.current;
    if (!current || !value.latitude) return;
    const center = new current.TMap.LatLng(value.latitude, value.longitude);
    current.marker.setGeometries([{ id: "store", position: center }]);
    current.circle.setGeometries([{ id: "range", styleId: "range", center, radius: radiusMeters }]);
  }, [value.latitude, value.longitude, radiusMeters]);

  const search = async () => {
    if (!keyword.trim() || !runtime.current) return;
    setSearching(true); setResults([]);
    try {
      // 全国模糊搜索：不携带 location/region，腾讯全库按关键词匹配（输入“建新园”即可列出相关门店）。
      const result = await runtime.current.suggestion.getSuggestions({ keyword: keyword.trim() });
      setResults((result.data || []).map((item) => ({ title: item.title, address: item.address, province: item.province, city: item.city, district: item.district, poiId: item.id, latitude: item.location.lat, longitude: item.location.lng })));
      if (!result.data?.length) setStatus("没有找到匹配地点，请调整关键词");
    } catch { setStatus("地点搜索失败，请稍后重试"); }
    finally { setSearching(false); }
  };
  const pick = (item) => { const current = runtime.current; const center = new current.TMap.LatLng(item.latitude, item.longitude); current.map.setCenter(center); onChange({ latitude: item.latitude, longitude: item.longitude, providerPoiId: item.poiId, coordinateSource: "poi", address: item.address, province: item.province, city: item.city, district: item.district }); setResults([]); setStatus("已选择地点，可继续拖动地图微调"); };
  const useCenter = () => { const center = runtime.current?.map.getCenter(); if (!center) return; onChange({ latitude: center.lat, longitude: center.lng, providerPoiId: value.providerPoiId || null, coordinateSource: "manual_adjusted" }); setStatus("已使用地图中心位置"); };

  return <section className="store-map-editor"><div className="map-search"><label><MagnifyingGlass size={18} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索门店或商场" /></label><button className="admin-secondary" onClick={search} disabled={searching || !runtime.current}>{searching ? "搜索中…" : "搜索"}</button></div>{results.length > 0 && <div className="map-search-results">{results.map((item) => <button key={`${item.poiId}-${item.title}`} onClick={() => pick(item)}><strong>{item.title}</strong><span>{item.address}</span></button>)}</div>}<div ref={container} className="store-map-canvas"><div className="map-placeholder"><MapPin size={28} /><span>{status}</span></div></div><div className="map-footer"><span>{status}</span><button className="admin-secondary" onClick={useCenter} disabled={!runtime.current}>使用地图中心位置</button></div></section>;
}
