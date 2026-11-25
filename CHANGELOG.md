# Changelog

## 1.0.0 — 2026-11-25
- 首版发布：两个工具（`agnes_image_generate`、`agnes_video_generate`）+ 图形设置页，共用同一个 Agnes API Key。
- 图像：文生图 / 图生图 / 多图合成，1K–4K 档位 × 8 种画幅；结果保存到会话目录 `agnes-images/` 并直接显示。
- 视频：文生视频 / 首尾帧控制 / 图片音频参考，固定 720P，4–12 秒；结果保存到 `agnes-videos/`。
- API Key 三来源：环境变量 `AGNES_API_KEY` → 凭据库 `AGENS_API_KEY`（上游拼写）；设置页可在线填写、清空、测试连通性，明文只留在宿主进程。
- 生成参数默认值：图像 size/ratio、视频 mode/seconds/aspect_ratio，设置页在线调整，无需重启插件。
- 设置页挂在宿主 `settings.section`（「Agnes 生成」导航项），本机数据面为 `/plugins/dsh-agnes-image-video/` 四条 HTTP 路由（`GET state` / `POST key` / `POST settings` / `POST verify`），全部带方法检查（405）与来源检查（403 `origin-not-trusted`）。
