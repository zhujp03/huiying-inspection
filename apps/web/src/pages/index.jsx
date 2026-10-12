// 页面桶文件（第 3 段完成）：
// 全部 11 页从各自文件 re-export，导出名与消费方式（App.jsx）不变：
// login/location/profile/help（入口四页）+ home/schedule/task/survey/issue（T3b 业务五页）
// + dishes/other（T3c 收尾两页：菜品与小票 §1.9、其他记录与提交 §1.10）。
// 每页文件头部注释标注该页区块 ↔ inventory 功能点对照（验收报告据此核对）。
export { LoginPage } from "./LoginPage.jsx";
export { LocationPage } from "./LocationPage.jsx";
export { ProfilePage } from "./ProfilePage.jsx";
export { HelpPage } from "./HelpPage.jsx";
export { HomePage } from "./HomePage.jsx";
export { SchedulePage } from "./SchedulePage.jsx";
export { TaskPage } from "./TaskPage.jsx";
export { SurveyPage } from "./SurveyPage.jsx";
export { IssuePage } from "./IssuePage.jsx";
export { DishesPage } from "./DishesPage.jsx";
export { OtherPage } from "./OtherPage.jsx";
