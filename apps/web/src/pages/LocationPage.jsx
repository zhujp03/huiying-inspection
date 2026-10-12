// LocationPage — 隐私与定位（中转页，inventory §1.2；rules R02 守卫在 App 壳 / R96 文案逐字）。
// 语义真源：apps/miniapp/miniprogram/pages/location/index.js。
// PM 钉定 Web 适配点 2：「打开设置」保留按钮，点击后 toast 提示（Web 无系统设置 API，
// 对齐 R96 openSetting 的 Web 化），不调用任何系统跳转。
import React, { useRef, useState } from "react";
import { Button, Card, Eyebrow, Muted } from "../design/components.jsx";
import { getCurrentLocation } from "../adapters/location.js";
import { useApp } from "./app-context.jsx";

const STATUS_MESSAGES = {
  idle: "位置仅用于判断是否到店打卡，不持续记录轨迹。",
  loading: "正在获取当前位置…",
  ready: "定位可用。开始任务时还会重新获取最新位置。",
  blocked: "未能获取位置，你仍可查看任务说明，但不能开始探店。",
};

export function LocationPage() {
  const { navigate, toast } = useApp();
  const [status, setStatus] = useState("idle"); // idle | loading | ready | blocked
  const locatingRef = useRef(false);

  const locate = () => {
    if (locatingRef.current) return; // loading 防重入
    locatingRef.current = true;
    setStatus("loading");
    getCurrentLocation()
      .then(() => setStatus("ready"))
      .catch(() => setStatus("blocked"))
      .finally(() => {
        locatingRef.current = false;
      });
  };

  const openSettings = () => {
    // PM 钉定 Web 适配点 2：Web 无系统设置 API，改为浏览器站点设置引导
    toast("请在浏览器地址栏旁的站点设置中重新允许定位，然后返回重试。");
  };

  const goSchedule = () => navigate("/schedule");

  return (
    <div className="app-page app-page--flat" data-page="location" data-status={status}>
      <div style={{ paddingTop: 56, textAlign: "center" }}>
        <Eyebrow>隐私与定位</Eyebrow>
        <div style={{ fontSize: 44, fontWeight: 700, color: "#f25f42", letterSpacing: 8, marginTop: 8 }}>到店</div>
      </div>
      <Card>
        <Muted>{STATUS_MESSAGES[status]}</Muted>
        <ul style={{ margin: "12px 0 0", paddingInlineStart: 18, color: "#70747b", fontSize: 13, lineHeight: 2 }}>
          <li>位置仅用于到店打卡</li>
          <li>不持续定位、不记录轨迹</li>
          <li>是否在门店范围内由系统判定</li>
        </ul>
      </Card>
      <div style={{ display: "grid", gap: 8 }}>
        {status !== "ready" ? (
          <>
            <Button disabled={status === "loading"} onClick={locate}>
              {status === "blocked" ? "重新定位" : "允许获取位置"}
            </Button>
            {status === "blocked" ? <Button variant="outline" onClick={openSettings}>打开设置</Button> : null}
          </>
        ) : (
          <Button onClick={goSchedule}>查看我的任务</Button>
        )}
      </div>
    </div>
  );
}
