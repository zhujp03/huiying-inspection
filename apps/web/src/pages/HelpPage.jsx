// HelpPage — 填写帮助（纯静态，inventory §1.11；小程序 pages/help/index.js 仅 Page({})，无交互）。
// 5 个静态帮助块沿用骨架文案；返回走 context.back，兜底路由 /profile（来源页，inventory §4.1）。
import React from "react";
import { Card, Muted, PageNav, SectionHeading } from "../design/components.jsx";
import { useApp } from "./app-context.jsx";

const HELP_SECTIONS = [
  ["开始任务", "在任务时间窗内到店，点击「开始任务」完成定位打卡后进入问卷。"],
  ["答题规则", "每题选择「得分」或「不得分」；不得分需填写说明并按题目要求上传照片或音频。"],
  ["菜品与消费小票", "上传消费小票（最多 9 张、每张 10MB 内），逐道菜品核对菜名、数量与金额。"],
  ["提交前检查", "确认全部题目已作答、菜品与小票填写完整后再提交；提交后不可回看或修改。"],
  ["定位与隐私", "位置仅用于判断是否到店打卡，不持续记录轨迹；范围判定由系统完成。"],
];

export function HelpPage() {
  const { back } = useApp();
  return (
    <div className="app-page app-page--flat" data-page="help">
      <PageNav title="填写帮助" onBack={() => back("/profile")} />
      {HELP_SECTIONS.map(([title, desc]) => (
        <Card key={title}>
          <SectionHeading>{title}</SectionHeading>
          <Muted>{desc}</Muted>
        </Card>
      ))}
    </div>
  );
}
