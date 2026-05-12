# 视联网智能运维平台交付说明

本文档面向接手部署和二次开发的同事，目标是帮助你把本地演示系统迁移到真实平台，并逐步接入真实摄像机、服务器、流链路、告警和诊断数据。

## 1. 系统定位

本系统是一个视联网智能运维 Web 平台，核心目标不是单纯播放视频，而是帮助运维人员完成这条链路：

发现异常摄像机 → 查看异常告警 → 触发根因诊断 → 定位根因实体和部件 → 查看统计分析。

当前系统包含 4 个核心板块：

- `运维大屏`：地图、摄像机点位、资源状态、黄金指标。
- `异常告警`：异常摄像机列表、异常视频预览、算法配置、告警确认。
- `根因诊断`：摄像机/服务器/流链路信息、视频预览、根因定位流程。
- `统计分析`：资源状态、画面异常类型、告警类型 TOP、根因实体 TOP。

左侧行政区树是全局设备目录，所有功能页都复用它。

## 2. 项目目录

```text
new_viotops_system/
├─ backend/                    # FastAPI 后端
│  ├─ main.py                  # 接口入口，业务接口主要在这里
│  ├─ models.py                # SQLAlchemy 数据表模型
│  ├─ schemas.py               # Pydantic 接口数据结构
│  ├─ database.py              # 数据库连接配置
│  ├─ create_tables.py         # 创建数据表
│  ├─ import_regions_from_amap.py # 从高德导入行政区
│  ├─ seed_huli_cameras.py     # 湖里区演示数据生成脚本
│  └─ videos/                  # 本地模拟视频源
│     ├─ normal.mp4
│     └─ anomaly.mp4
├─ frontend/                   # Vite + React + Tailwind 前端
│  ├─ src/
│  │  ├─ components/layout/MasterLayout.jsx # 母版、顶部栏、左侧树、底部栏
│  │  ├─ pages/MapView.jsx                  # 运维大屏
│  │  ├─ pages/VideoAlarmManage.jsx         # 异常告警
│  │  ├─ pages/DeviceManage.jsx             # 根因诊断
│  │  ├─ pages/StatisticsView.jsx           # 统计分析
│  │  ├─ services/                          # 前端 API 封装
│  │  └─ index.css                          # 全局主题、字号、布局变量
│  ├─ vite.config.js            # Vite 配置和代理
│  └─ .env.local                # 本地前端环境变量
├─ tips.md                      # 开发规范
└─ README.md                    # 本文档
```

## 3. 技术栈

前端：

- Vite
- React
- Tailwind CSS
- lucide-react 图标
- axios 请求后端

后端：

- FastAPI
- Uvicorn
- SQLAlchemy
- PyMySQL
- Pydantic
- MySQL

地图：

- 高德地图 JS API
- 高德行政区/POI Web 服务

## 4. 本地启动

### 4.1 准备环境

建议版本：

- Node.js 20+
- Python 3.10+
- MySQL 8+

### 4.2 安装前端依赖

```bash
cd frontend
npm install
```

### 4.3 安装后端依赖

项目当前没有单独维护 `requirements.txt`，可以先安装这些依赖：

```bash
pip install fastapi uvicorn sqlalchemy pymysql pydantic requests
```

### 4.4 配置数据库

后端数据库连接在：

```text
backend/database.py
```

默认连接：

```text
mysql+pymysql://root:12345678@localhost:3306/viot_ops_dev?charset=utf8mb4
```

推荐不要直接改代码，而是通过环境变量覆盖：

```bash
set SQLALCHEMY_DATABASE_URL=mysql+pymysql://用户名:密码@数据库IP:3306/数据库名?charset=utf8mb4
```

Linux/macOS：

```bash
export SQLALCHEMY_DATABASE_URL='mysql+pymysql://用户名:密码@数据库IP:3306/数据库名?charset=utf8mb4'
```

先在 MySQL 中创建数据库：

```sql
CREATE DATABASE viot_ops_dev DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

创建表：

```bash
cd backend
python create_tables.py
```

### 4.5 导入行政区

真实部署至少要有行政区，否则左侧树和摄像机归属无法正常工作。

设置高德 Web 服务 Key：

```bash
set AMAP_KEY=你的高德Web服务Key
```

导入厦门市或湖里区所在范围示例：

```bash
cd backend
python import_regions_from_amap.py --keywords 福建省
```

如果是开发库，允许清空后重导：

```bash
python import_regions_from_amap.py --keywords 福建省 --reset
```

注意：真实生产库不要随便加 `--reset`，否则行政区外键可能影响摄像机数据。

### 4.6 导入演示摄像机数据

如果只是本地演示，可以使用湖里区 seed：

```bash
cd backend
python seed_huli_cameras.py --count 1000 --reset-business
```

这个脚本会写入摄像机、服务器、流链路、故障事件、拓扑连线等演示数据。

真实平台部署时，这个脚本只作为数据结构参考，不建议直接用于生产库。

### 4.7 启动后端

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

检查接口文档：

```text
http://127.0.0.1:8000/docs
```

### 4.8 启动前端

```bash
cd frontend
npm run dev -- --host 0.0.0.0
```

默认访问：

```text
http://127.0.0.1:5173
```

局域网访问时，用前端机器的局域网 IP：

```text
http://你的电脑局域网IP:5173
```

## 5. 前端配置

前端环境变量在：

```text
frontend/.env.local
```

当前主要配置：

```text
AMAP_KEY=高德Web服务Key
AMAP_SECURITY_JS_CODE=高德安全密钥
VITE_API_BASE_URL=/api/backend
```

前端请求封装在：

```text
frontend/src/services/request.js
```

Vite 后端代理在：

```text
frontend/vite.config.js
```

本地默认代理到：

```text
http://127.0.0.1:8000
```

如果前端部署在另一台机器，或者后端地址不是本机，需要设置：

```bash
VITE_BACKEND_PROXY_TARGET=http://后端服务器IP:8000
```

生产环境如果使用 Nginx，推荐由 Nginx 把 `/api/backend` 反向代理到后端，而不是让浏览器直接访问 `127.0.0.1:8000`。

## 6. 生产部署建议

### 6.1 前端构建

```bash
cd frontend
npm install
npm run build
```

构建产物：

```text
frontend/dist/
```

把 `dist` 放到 Nginx 静态目录。

### 6.2 Nginx 示例

```nginx
server {
    listen 80;
    server_name your-domain-or-ip;

    root /opt/viotops/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/backend/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /videos/ {
        proxy_pass http://127.0.0.1:8000/videos/;
    }
}
```

### 6.3 后端生产启动

开发环境可以用：

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

生产环境建议用 systemd/supervisor 守护进程，或者用 Docker 部署。

## 7. 数据库核心表说明

主要模型在：

```text
backend/models.py
```

核心表：

- `administrative_region`：行政区，省/市/区县/乡镇街道。
- `camera`：摄像机设备。
- `server`：服务器节点。
- `stream_media`：摄像机到服务器的流链路。
- `network_node`：交换机、路由器等网络节点。
- `topology_link`：拓扑连线。
- `fault_event`：故障/异常事件。
- `root_cause`：根因记录。
- `video_diagnosis`：视频诊断记录。
- `work_order`：当前保留给诊断自动生成工单记录，前端已不单独展示工单板块。

摄像机状态约定：

```text
online  = 正常在线
fault   = 异常
offline = 离线
```

服务器状态约定：

```text
normal  = 正常
fault   = 异常
warning = 告警
offline = 离线
```

流链路状态由两个字段组合：

```text
is_connected = 是否连通
is_fault     = 是否异常
```

## 8. 真实数据接入指导

真实接入时，建议先按下面顺序迁移。

### 8.1 接入行政区

摄像机必须挂到乡级行政区，即 `camera.town_code`。

如果真实平台已有行政区编码，可以直接写入 `administrative_region`。

最低要求：

- 省级：`level='province'`
- 市级：`level='city'`
- 区县：`level='county'`
- 乡镇街道：`level='town'`
- 下级的 `parent_code` 指向上级 `region_code`

### 8.2 接入摄像机

写入 `camera` 表时重点字段：

- `id`：摄像机唯一 ID。
- `name`：摄像机名称。
- `ip`：摄像机 IP。
- `status`：`online/fault/offline`。
- `province_code/city_code/county_code/town_code`：行政区编码。
- `province_name/city_name/county_name/town_name`：行政区名称。
- `longitude/latitude`：经纬度，运维大屏地图点位依赖它。
- `server_id`：绑定的流媒体服务器。
- `protocol`：建议统一 `RTSP`。
- `codec`：编码格式，例如 `H.264/H.265`。

注意：没有经纬度的摄像机不会在地图上正常展示。

### 8.3 接入服务器

写入 `server` 表：

- `id`
- `name`
- `ip`
- `node_type`，如 `stream_server/gateway_server/database_server`
- `status`
- `longitude/latitude`
- `cpu_usage/ram_usage/disk_usage/net_bandwidth/gpu_usage`

服务器指标用于根因诊断详情页和统计分析。

### 8.4 接入流链路

写入 `stream_media` 表：

- `id`
- `camera_id`
- `server_id`
- `source_ip/source_port`
- `destination_ip/destination_port`
- `ssrc`
- `is_connected`
- `is_fault`
- `latency`
- `jitter`
- `packet_loss_rate`
- `throughput`
- `qoe_score`
- `real_time_bitrate`

统计分析的黄金指标、画面异常类型、链路健康度都依赖这些字段。

### 8.5 接入异常告警

当前异常告警页主要从摄像机状态和流链路指标推断告警。

如果真实平台已有告警系统，可以选择两种方式：

1. 写入 `fault_event` 表，让统计分析能读取历史故障。
2. 改造 `frontend/src/pages/VideoAlarmManage.jsx` 和后端接口，让告警列表直接读取真实告警接口。

告警模块关注三个问题：

- 哪台摄像机异常？
- 异常类型是什么？
- 是否已经确认？

根因是什么，不在告警模块解决，而交给根因诊断模块。

### 8.6 接入根因诊断

当前根因诊断接口在：

```text
POST /cameras/{camera_id}/diagnoses/run
GET  /cameras/{camera_id}/diagnoses/latest
```

实现位置：

```text
backend/main.py
```

目前 `_diagnosis_profile(camera)` 是模拟诊断逻辑。如果接入真实算法，需要重点替换这里：

```text
backend/main.py -> _diagnosis_profile
backend/main.py -> run_video_diagnosis
```

真实算法建议返回：

- 健康分数 `health_score`
- 业务状态 `business_status`
- 一级根因 `level1`
- 二级根因 `level2`
- 三级根因 `level3`
- 定位依据 `reason`
- 拓扑信息 `topology`
- 处置建议 `suggestion`

前端诊断展示在：

```text
frontend/src/pages/DeviceManage.jsx
```

## 9. 功能代码位置

### 9.1 母版和左侧行政区树

```text
frontend/src/components/layout/MasterLayout.jsx
```

负责：

- 顶部功能导航
- 左侧行政区树
- 我的收藏
- 自定义分区
- 左侧树筛选
- 底部工具栏
- 页面切换

左侧树接口：

```text
GET /nav-tree/children
GET /nav-tree/cameras
GET /nav-tree/search
GET /nav-tree/node
```

接口实现：

```text
backend/main.py
```

### 9.2 运维大屏

```text
frontend/src/pages/MapView.jsx
```

负责：

- 高德地图加载
- 行政区定位
- 摄像机点位展示
- 单击摄像机预览视频
- 跳转详情/根因诊断
- 右侧资源状态和黄金指标

相关服务：

```text
frontend/src/services/mapApi.js
frontend/src/services/statisticsApi.js
frontend/src/services/videoApi.js
```

### 9.3 异常告警

```text
frontend/src/pages/VideoAlarmManage.jsx
```

负责：

- 告警列表
- 告警状态确认
- 告警视频预览
- 异常指标折线图
- 算法配置展示
- 跳转根因诊断

注意：当前 Fake 摄像机不会进入异常告警列表，避免污染演示 case。

### 9.4 根因诊断

```text
frontend/src/pages/DeviceManage.jsx
```

负责：

- 摄像机、服务器、流链路列表
- 设备详情
- 摄像机预览
- 视频诊断/根因定位流程
- 诊断历史读取
- 诊断结果展示

相关接口封装：

```text
frontend/src/services/deviceApi.js
frontend/src/services/diagnosisApi.js
```

后端诊断逻辑：

```text
backend/main.py
```

### 9.5 统计分析

```text
frontend/src/pages/StatisticsView.jsx
```

后端统计接口：

```text
GET /statistics/overview
```

实现位置：

```text
backend/main.py
```

统计内容：

- 摄像机/流链路/服务器状态
- 流链路全局健康度
- 画面异常类型统计
- 告警类型 TOP
- 根因实体 TOP

## 10. 本地视频源

视频文件位置：

```text
backend/videos/normal.mp4
backend/videos/anomaly.mp4
```

后端通过 FastAPI 静态服务暴露：

```text
/videos/normal.mp4
/videos/anomaly.mp4
```

当前逻辑：

- 正常摄像机播放 `normal.mp4`
- 异常摄像机播放 `anomaly.mp4`
- 离线摄像机不播放视频

真实平台接入时，需要把 `GET /cameras/{camera_id}/preview` 改为返回真实视频播放地址，或者返回平台已有的 HLS/FLV/RTSP 转码地址。

## 11. 局域网访问注意事项

如果前端能打开，但没有数据，通常是后端地址配置错了。

开发环境建议：

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
npm run dev -- --host 0.0.0.0
```

前端不要让浏览器直接请求：

```text
http://127.0.0.1:8000
```

因为其他电脑上的 `127.0.0.1` 指的是它自己，不是你的后端机器。

应该通过 Vite 代理或 Nginx 代理统一走：

```text
/api/backend
```

## 12. 常见问题

### 12.1 左侧树加载不出来

检查：

- 后端是否启动。
- `/docs` 是否能打开。
- 数据库是否有 `administrative_region`。
- 摄像机是否挂了正确的 `town_code`。

### 12.2 地图没有摄像机点位

检查：

- 摄像机是否有 `longitude/latitude`。
- 当前地图缩放级别是否足够细。
- `frontend/.env.local` 是否配置了高德 Key。
- 浏览器控制台是否有高德 Key 或安全密钥错误。

### 12.3 异常告警里看不到某些摄像机

当前异常告警会排除 `F` 或 `Z` 开头的 Fake 摄像机。

这是为了避免大规模虚拟接入数据污染演示告警 case。

### 12.4 根因诊断列表不展示 Fake 摄像机

这是设计行为。

顶部统计显示全量规模，列表只展示真实/演示可操作设备。

### 12.5 前端报 422

通常是接口参数不符合后端限制，例如 `limit` 超过后端定义范围。

打开浏览器 F12，看具体是哪一个接口，再到 `backend/main.py` 查对应接口参数。

### 12.6 视频黑屏

检查：

- `backend/videos/normal.mp4`
- `backend/videos/anomaly.mp4`
- 浏览器是否能直接打开 `/videos/normal.mp4`
- 视频编码是否是浏览器支持的 H.264/AAC。

## 13. 二次开发规范

请先阅读：

```text
tips.md
```

重要原则：

- 不要重复实现顶部栏、左侧树、底部栏。
- 新页面只写右侧内容区和右侧底部工具区。
- 字号、颜色、间距优先使用 `frontend/src/index.css` 里的 CSS 变量。
- 摄像机状态不要乱改，数据库仍然使用 `online/fault/offline`。
- 修改后至少运行：

```bash
cd frontend
npm run build
```

后端修改后运行：

```bash
cd backend
python -m py_compile main.py
```

## 14. 交付前检查清单

- [ ] MySQL 数据库已创建。
- [ ] `SQLALCHEMY_DATABASE_URL` 已配置为真实数据库。
- [ ] 后端 `/docs` 能打开。
- [ ] 行政区数据已导入。
- [ ] 摄像机数据已写入并绑定乡级行政区。
- [ ] 摄像机经纬度可用。
- [ ] 服务器数据已写入。
- [ ] 流链路数据已写入。
- [ ] 前端 `.env.local` 或生产环境变量已配置。
- [ ] Nginx 已代理 `/api/backend` 到 FastAPI。
- [ ] Nginx 已代理 `/videos` 或真实视频服务地址。
- [ ] 运维大屏、异常告警、根因诊断、统计分析均能打开。

