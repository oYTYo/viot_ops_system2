import { useState, useEffect, useRef } from 'react';
// 在其他 import 语句之后插入
import TopologyManagement from './pages/TopologyManagement';
import DeviceInformation from './pages/DeviceInformation';
import AnomalyDetection from './pages/AnomalyDetection';
import RootCauseAnalysis from './pages/RootCauseAnalysis';
import FaultRepair from './pages/FaultRepair';


// 引入背景图
import bgImage from './assets/bg.png';

import AMapLoader from '@amap/amap-jsapi-loader';

import { AMAP_KEY } from './amap_config';

import { listServers, listCameras, listFaultEvents } from './api/client';
import { buildTopology } from './utils/topology';



// --- 首页专用悬浮地图组件 (增加防御性校验) ---
const HomeMap = () => {
  const mapRef = useRef(null);
  const mapInstance = useRef(null); // 增加对实例的引用

  useEffect(() => {
    let disposed = false; // 添加卸载标志避免异步更新已销毁的组件

    const initMap = async () => {
      try {
        // 使用 Promise.all 并发请求地图实例和后端真实数据
        const [AMap, camerasData, serversData] = await Promise.all([
          AMapLoader.load({
            key: AMAP_KEY,
            version: "2.0",
            plugins: ['AMap.MarkerClusterer', 'AMap.Polyline', 'AMap.MoveAnimation'],
          }),
          listCameras(),
          listServers()
        ]);

        if (disposed || !mapRef.current) return;
        
        // 如果已经存在实例，先销毁，防止重复挂载
        if (mapInstance.current) {
          mapInstance.current.destroy();
        }

        const map = new AMap.Map(mapRef.current, {
          zoom: 13,
          center: [118.1467, 24.5126],
          viewMode: '3D',
          mapStyle: 'amap://styles/darkblue',
        });
        
        mapInstance.current = map;

        // 复用 utils/topology 中已有的坐标清洗和 fallback 生成逻辑
        const { servers, cameras } = buildTopology(
          Array.isArray(serversData) ? serversData : (serversData?.data || []),
          Array.isArray(camerasData) ? camerasData : (camerasData?.data || [])
        );

        // 渲染服务器
        servers.forEach(s => {
          if (!s.pos) return;
          const marker = new AMap.Marker({
            position: s.pos,
            content: `<div class="w-12 h-12 rounded-full bg-tertiary/20 border-2 border-tertiary flex items-center justify-center shadow-[0_0_25px_rgba(203,123,255,0.8)]">
                        <span class="material-symbols-outlined text-tertiary text-3xl">storage</span>
                      </div>`,
            offset: new AMap.Pixel(-24, -24)
          });
          map.add(marker);
        });

        // 渲染摄像头及连线
        cameras.forEach(c => {
          if (!c.pos) return;

          // 兼容查找绑定的服务器实体
          const server = servers.find(s => s.id === (c.server_id || c.serverId));
          
          if (server && server.pos) {
            // 1. 基础连线
            const polyline = new AMap.Polyline({
              path: [c.pos, server.pos],
              strokeColor: "#81ecff",
              strokeOpacity: 0.6,
              strokeWeight: 2,
              strokeStyle: "dashed",
              showDir: true
            });
            map.add(polyline);

            // 2. 数据流粒子
            const flowParticle = new AMap.Marker({
              position: c.pos,
              content: `<div class="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_10px_3px_rgba(129,236,255,0.9)]"></div>`,
              offset: new AMap.Pixel(-3, -3)
            });
            map.add(flowParticle);

            // 3. 粒子动画
            flowParticle.moveAlong(
              [c.pos, server.pos], 
              {
                speed: 2500,
                circlable: true
              }
            );
          }

          // 4. 摄像机图标
          map.add(new AMap.Marker({
            position: c.pos,
            content: `<div class="w-10 h-10 rounded-full bg-primary/20 border-2 border-primary/80 flex items-center justify-center shadow-[0_0_15px_rgba(129,236,255,0.5)]">
                        <span class="material-symbols-outlined text-primary text-xl">videocam</span>
                      </div>`,
            offset: new AMap.Pixel(-20, -20)
          }));
        });

      } catch (e) {
        console.error("HomeMap Load Error:", e);
      }
    };

    initMap();

    // 组件卸载时销毁地图
    return () => {
      disposed = true; 
      if (mapInstance.current) {
        mapInstance.current.destroy();
        mapInstance.current = null;
      }
    };
  }, []);

  return <div ref={mapRef} className="absolute inset-0 w-full h-full opacity-80 bg-[#050e20]" />;
};





function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [currentTime, setCurrentTime] = useState('');
  const [pulse, setPulse] = useState(false);
  const [rootCauseRequest, setRootCauseRequest] = useState(null);

  // 新增：实时故障数据状态
  const [faultEvents, setFaultEvents] = useState([]);

  // 新增：从后端拉取故障数据
  useEffect(() => {
    const formatClock = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    };

    const fetchFaultEvents = async () => {
      try {
        const faultRes = await listFaultEvents({ limit: 50 });
        const events = Array.isArray(faultRes) ? faultRes : (faultRes?.data || []);

        const [cameraResult, serverResult] = await Promise.allSettled([
          listCameras({ limit: 2000 }),
          listServers({ limit: 2000 }),
        ]);
        const cameras = cameraResult.status === 'fulfilled'
          ? (Array.isArray(cameraResult.value) ? cameraResult.value : (cameraResult.value?.data || []))
          : [];
        const servers = serverResult.status === 'fulfilled'
          ? (Array.isArray(serverResult.value) ? serverResult.value : (serverResult.value?.data || []))
          : [];
        const cameraMap = new Map(cameras.map((camera) => [camera.id, camera]));
        const serverMap = new Map(servers.map((server) => [server.id, server]));

        const normalizedEvents = events
          .filter((event) => event)
          .sort((a, b) => new Date(b.trigger_time).getTime() - new Date(a.trigger_time).getTime())
          .map((event) => {
            const device = event.entity_type === 'camera'
              ? cameraMap.get(event.entity_id)
              : serverMap.get(event.entity_id);

            return {
              id: event.id,
              pointName: device?.name || event.entity_id || '未知设备',
              ssrc: event.entity_id || 'N/A',
              faultType: event.category_l3 || event.fault_desc || event.fault_code || '未知故障',
              level: event.level || '次要',
              time: formatClock(event.trigger_time),
              status: event.status || '',
            };
          });

        setFaultEvents(normalizedEvents);
      } catch (error) {
        console.error("Failed to fetch fault events:", error);
        setFaultEvents([]);
      }
    };

    fetchFaultEvents();
    // 可选：如果大屏需要实时滚动更新，可以取消下面轮询的注释（比如每 15 秒刷新一次）
    // const intervalId = setInterval(fetchFaultEvents, 15000);
    // return () => clearInterval(intervalId);
  }, []);

  const handleStartRootCause = (fault) => {
    if (!fault) return;
    setRootCauseRequest({
      ...fault,
      requestedAt: Date.now(),
    });
    setActiveTab('rootcause');
  };
  
  // --- 1. 模拟数据状态重构（设备总数设为固定值） ---
  const [metrics, setMetrics] = useState({
    devices: 2000, 
    cameras: 1400, // 2000 * 70%
    nvrs: 600,     // 2000 * 30%
    servers: 3,
    online: 1860,
    links: 4020,
    connected: 3380,
    alarms: 42,
    critical: 12
  });

  // 大屏自适应缩放逻辑
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const handleResize = () => {
      // 按照 1920x1080 的比例计算缩放倍数
      const ratio = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      setScale(ratio);
    };
    handleResize(); // 初始化执行一次
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 时钟逻辑
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const str = now.getFullYear() + '-' + 
                  String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                  String(now.getDate()).padStart(2, '0') + ' ' + 
                  String(now.getHours()).padStart(2, '0') + ':' + 
                  String(now.getMinutes()).padStart(2, '0') + ':' + 
                  String(now.getSeconds()).padStart(2, '0');
      setCurrentTime(str);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // --- 2. 仿真引擎逻辑（引入概率闸门与单向增长） ---
  useEffect(() => {
    const metricTimer = setInterval(() => {
      // 80% 的概率保持不动，只有 20% 的机会进入更新逻辑
      if (Math.random() > 0.7) return;

      setMetrics(prev => {
        // A. 告警逻辑：只能增加，不能减少
        const alarmAdded = Math.random() > 0.7 ? 1 : 0; // 即使进入更新逻辑，也只有 30% 概率真的新增告警
        const newAlarms = prev.alarms + alarmAdded;
        
        // 严重告警：只能增加，且不能超过总数的 50%
        let newCritical = prev.critical;
        if (alarmAdded && newCritical < newAlarms * 0.5 && Math.random() > 0.5) {
          newCritical += 1;
        }

        // B. 设备在线：不低于 80% 随机波动
        const newOnline = Math.floor(prev.devices * (0.85 + Math.random() * 0.14));

        // C. 链路逻辑：总数约为设备 2 倍，微弱波动
        const newLinks = prev.devices * 2 + Math.floor(Math.random() * 50);
        // 连通链路：不低于链路总数的 70%
        const newConnected = Math.floor(newLinks * (0.75 + Math.random() * 0.24));

        return {
          ...prev, // 保持 devices, cameras, nvrs, servers 等静态值不动
          online: newOnline,
          links: newLinks,
          connected: newConnected,
          alarms: newAlarms,
          critical: newCritical,
        };
      });

      setPulse(true);
      setTimeout(() => setPulse(false), 300);
    }, 3000);
    return () => clearInterval(metricTimer);
  }, []);

  // --- 3. 实时指标计算（用于展示层动态绑定） ---
  const onlineRate = ((metrics.online / metrics.devices) * 100).toFixed(1);
  const connectRate = ((metrics.connected / metrics.links) * 100).toFixed(1);
  // 设备异常率：基于告警总数占比
  const deviceAnomaly = ((metrics.alarms / metrics.devices) * 100).toFixed(1);
  // 链路异常率：基于未连通链路占比
  const linkAnomaly = (((metrics.links - metrics.connected) / metrics.links) * 100).toFixed(1);

  const pulseClass = pulse ? "scale-110 text-white transition-all duration-300" : "transition-all duration-300";

  return (
    // 最外层变成全屏且居中
    <div 
     className="w-screen h-screen bg-cover bg-center overflow-hidden flex items-center justify-center"
     style={{ backgroundImage: `url(${bgImage})` }}>
      
      {/* 核心容器：固定 1920x1080，通过 transform 整体缩放 */}
      <div 
        className="w-[2100px] h-[1080px] shrink-0 origin-center relative overflow-hidden flex flex-col"
        style={{ transform: `scale(${scale})` }}
      >
        
        {/* Top Bar */}
        <header className="h-20 flex justify-between items-center px-10 bg-[#050e20]/90 border-b border-primary/20 z-50">
          <div className="flex items-center gap-6">
            <span className="material-symbols-outlined text-primary text-5xl" style={{ fontVariationSettings: "'FILL' 1" }}>hub</span>
            <h1 className="text-5xl font-black tracking-tight text-primary font-headline">视联网智能运维平台</h1>
          </div>
          <div className="flex items-center gap-10">
            <div className="text-right">
              <p className="text-sys-lg font-mono text-primary font-bold">{currentTime || 'Loading...'}</p>
            </div>
            <div className="flex gap-6 border-l border-outline/30 pl-8">
              <span className="material-symbols-outlined text-4xl text-primary">notifications</span>
              <span className="material-symbols-outlined text-4xl text-on-surface-variant">account_circle</span>
            </div>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Navigation */}
          <nav className="w-36 bg-surface-container-low/80 border-r border-primary/10 flex flex-col items-center py-4 gap-6">


            {/* 1. 综合大屏 - 增加点击事件并改为动态样式 */}
            <div 
              className={`flex flex-col items-center gap-2 py-4 w-full cursor-pointer transition-all ${
                activeTab === 'home' 
                ? 'text-primary bg-primary/10 border-r-4 border-primary' 
                : 'text-on-surface-variant hover:text-primary'
              }`}
              onClick={() => setActiveTab('home')}
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: activeTab === 'home' ? "'FILL' 1" : "" }}>
                dashboard
              </span>
              <span className="font-bold">综合大屏</span>
            </div>

            {/* 2. 拓扑管理 - 改为动态样式 */}
            <div 
              className={`flex flex-col items-center gap-2 py-4 w-full cursor-pointer transition-all ${
                activeTab === 'topology' 
                ? 'text-primary bg-primary/10 border-r-4 border-primary' 
                : 'text-on-surface-variant hover:text-primary'
              }`}
              onClick={() => setActiveTab('topology')}
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: activeTab === 'topology' ? "'FILL' 1" : "" }}>
                hub
              </span>
              <span className="font-bold">拓扑管理</span>
            </div>
            
            {/* 3. 设备信息 */}
            <div 
              className={`flex flex-col items-center gap-2 py-4 w-full cursor-pointer transition-all ${
                activeTab === 'device' ? 'text-primary bg-primary/10 border-r-4 border-primary' : 'text-on-surface-variant hover:text-primary'
              }`}
              onClick={() => setActiveTab('device')}
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: activeTab === 'device' ? "'FILL' 1" : "" }}>settings_input_component</span>
              <span className="font-bold">设备信息</span>
            </div>


            {/* 4. 异常检测 */}
            <div 
              className={`flex flex-col items-center gap-2 py-4 w-full cursor-pointer transition-all ${
                activeTab === 'alarm' ? 'text-primary bg-primary/10 border-r-4 border-primary' : 'text-on-surface-variant hover:text-primary'
              }`}
              onClick={() => setActiveTab('alarm')}
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: activeTab === 'alarm' ? "'FILL' 1" : "" }}>error</span>
              <span className="font-bold">异常检测</span>
            </div>


            {/* 5. 根因分析 */}
            <div 
              className={`flex flex-col items-center gap-2 py-4 w-full cursor-pointer transition-all ${
                activeTab === 'rootcause' ? 'text-primary bg-primary/10 border-r-4 border-primary' : 'text-on-surface-variant hover:text-primary'
              }`}
              onClick={() => setActiveTab('rootcause')}
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: activeTab === 'rootcause' ? "'FILL' 1" : "" }}>psychology</span>
              <span className="font-bold">根因分析</span>
            </div>


            {/* 6. 故障修复 */}
            <div 
              className={`flex flex-col items-center gap-2 py-4 w-full cursor-pointer transition-all ${
                activeTab === 'repair' ? 'text-primary bg-primary/10 border-r-4 border-primary' : 'text-on-surface-variant hover:text-primary'
              }`}
              onClick={() => setActiveTab('repair')}
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: activeTab === 'repair' ? "'FILL' 1" : "" }}>build</span>
              <span className="font-bold">故障修复</span>
            </div>

          </nav>


          {/* Main Content Grid */}
          <main className="flex-1 overflow-hidden relative z-10">
  
          {/* 1. 首页内容：只有当 activeTab 为 'home' 时才显示 */}
          {activeTab === 'home' && ( 

            <div className="w-full h-full p-4 grid grid-cols-12 grid-rows-5 gap-y-6 gap-x-4">
            



            {/* Left Panels */}
            <div className="col-span-3 row-span-3 flex flex-col gap-2">
              {/* 网络运行概览 */}
              <section className="glass-card flex-1 rounded-2xl p-6 flex flex-col">
                <h2 className="text-sys-lg font-bold text-primary mb-6 border-l-4 border-primary pl-3">网络运行概览</h2>
                <div className="flex-1 flex justify-around items-center">
                  <div className="text-center">
                    <div className="relative w-32 h-32 flex items-center justify-center mb-2">
                      <svg className="absolute inset-0 transform -rotate-90 w-full h-full">
                        <circle className="text-surface-container-high" cx="64" cy="64" fill="transparent" r="56" stroke="currentColor" strokeWidth="10"></circle>
                        <circle className="text-primary" cx="64" cy="64" fill="transparent" r="56" stroke="currentColor" strokeDasharray="351.8" strokeDashoffset="35" strokeWidth="10"></circle>
                      </svg>
                      <span className="text-sys-lg font-black">{onlineRate}%</span>
                    </div>
                    <p className="font-bold">设备在线率</p>
                  </div>
                  <div className="text-center">
                    <div className="relative w-32 h-32 flex items-center justify-center mb-2">
                      <svg className="absolute inset-0 transform -rotate-90 w-full h-full">
                        <circle className="text-surface-container-high" cx="64" cy="64" fill="transparent" r="56" stroke="currentColor" strokeWidth="10"></circle>
                        <circle className="text-error" cx="64" cy="64" fill="transparent" r="56" stroke="currentColor" strokeDasharray="351.8" strokeDashoffset="105" strokeWidth="10"></circle>
                      </svg>
                      <span className="text-sys-lg font-black">{connectRate}%</span>
                    </div>
                    <p className="font-bold">链路连通率</p>
                  </div>
                </div>
              </section>

             {/* AI赋能与算法纳管 */}
            <section className="glass-card flex-1 rounded-2xl p-6 flex flex-col">
              <h2 className="text-sys-lg font-bold text-tertiary mb-4 border-l-4 border-tertiary pl-3 shrink-0">AI赋能与算法纳管</h2>
              
              {/* 左右并排容器 */}
              <div className="flex-1 flex gap-4 items-stretch">
                
                {/* 1. AI覆盖设备 (左侧) */}
                <div className="flex-1 bg-surface-container-low/50 p-5 rounded-xl border border-tertiary/20 hover:border-tertiary/50 transition-colors flex flex-col justify-between">
                  {/* 数据在上：将间距从 space-y-3 修改为 space-y-1 (或 flex flex-col gap-1.5) 以贴近数字 */}
                  <div className="flex flex-col gap-1.5">
                    <div className="font-mono flex items-baseline gap-2">
                      <span className={`text-4xl font-black text-tertiary ${pulseClass}`}>1,250</span>
                      <span className="text-sys-sm text-on-surface-variant font-bold">/ {metrics.devices}</span>
                    </div>
                    {/* 进度条 */}
                    <div className="h-2 bg-surface-container-highest rounded-full overflow-hidden border border-white/5 relative shadow-inner">
                      <div className="h-full bg-gradient-to-r from-tertiary/40 to-tertiary w-[62.5%] relative">
                         <div className="absolute inset-0 bg-white/20 w-full animate-pulse"></div>
                      </div>
                    </div>
                  </div>

                  {/* 标签在底部 */}
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-tertiary text-xl">memory</span>
                    <span className="font-bold text-on-surface-variant text-sys-sm whitespace-nowrap">AI覆盖设备</span>
                  </div>
                </div>

                {/* 2. 纳管算法数 (右侧) */}
                <div className="flex-1 bg-surface-container-low/50 p-5 rounded-xl border border-secondary/20 hover:border-secondary/50 transition-colors flex flex-col items-center justify-between text-center">
                  {/* 数据与功能标签在上 - 居中放置 */}
                  <div className="flex flex-col items-center gap-3">
                    <div className="font-mono flex items-baseline gap-1">
                      <span className="text-4xl font-black text-secondary">24</span>
                      <span className="text-sys-sm font-bold text-secondary">种</span>
                    </div>
                    {/* 功能微标签组 */}
                    <div className="flex gap-2">
                      <span className="px-2 py-0.5 rounded bg-secondary/10 border border-secondary/30 text-secondary text-[11px] font-bold whitespace-nowrap">异常检测</span>
                      <span className="px-2 py-0.5 rounded bg-secondary/10 border border-secondary/30 text-secondary text-[11px] font-bold whitespace-nowrap">根因分析</span>
                    </div>
                  </div>

                  {/* 标签在底部 */}
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-secondary text-xl">model_training</span>
                    <span className="font-bold text-on-surface-variant text-sys-sm whitespace-nowrap">纳管算法数</span>
                  </div>
                </div>

              </div>
            </section>

            </div>




            {/* Central Map & Metrics - 轴对称重构布局 (修改：由雷达变更为地图背景与悬浮指标) */}
            {/* 加入 glass-card 和边框类，复用全局信息框样式 */}
            <div className="col-span-6 row-span-3 glass-card rounded-2xl relative flex items-center justify-between px-12 overflow-hidden border border-primary/10">
              
              {/* 1. 底层：复用的地图组件，绝对定位铺满 */}
              <HomeMap />

              {/* 2. 辅助遮罩层：左右两端加深暗色渐变，保证浅色文字在地图背景上清晰可见 */}
              <div className="absolute inset-0 bg-gradient-to-r from-[#050e20]/80 via-transparent to-[#050e20]/80 pointer-events-none z-0"></div>

              {/* 3. 顶层悬浮：左侧列 */}
              {/* 使用 relative z-10 提升层级，同时使用 pointer-events 保证鼠标能穿透并拖拽背后的地图 */}
              <div className="relative z-10 flex flex-col gap-16 items-end pointer-events-none [&>*]:pointer-events-auto">
                {/* 设备总数 */}
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className={`text-sys-lg font-black ${pulseClass}`}>{metrics.devices}</p>
                    <p className="text-sys-sm font-bold text-on-surface-variant">设备总数</p>
                  </div>
                  <div className="w-24 h-24 glass-card rounded-full flex items-center justify-center border-2 border-primary">
                    <span className="material-symbols-outlined text-5xl text-primary">devices</span>
                  </div>
                </div>
                {/* 链路总数 */}
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className={`text-sys-lg font-black ${pulseClass}`}>{metrics.links}</p>
                    <p className="text-sys-sm font-bold text-on-surface-variant">链路总数</p>
                  </div>
                  <div className="w-24 h-24 glass-card rounded-full flex items-center justify-center border-2 border-primary">
                    <span className="material-symbols-outlined text-5xl text-primary">lan</span>
                  </div>
                </div>
                {/* 告警总数 */}
                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <p className={`text-sys-lg font-black ${pulseClass}`}>{metrics.alarms}</p>
                    <p className="text-sys-sm font-bold text-on-surface-variant">告警总数</p>
                  </div>
                  <div className="w-24 h-24 glass-card rounded-full flex items-center justify-center border-2 border-secondary">
                    <span className="material-symbols-outlined text-5xl text-secondary">warning</span>
                  </div>
                </div>
              </div>

              {/* 4. 顶层悬浮：右侧列 */}
              <div className="relative z-10 flex flex-col gap-16 items-start pointer-events-none [&>*]:pointer-events-auto">
                {/* 在线设备 */}
                <div className="flex items-center gap-6">
                  <div className="w-24 h-24 glass-card rounded-full flex items-center justify-center border-2 border-primary">
                    <span className="material-symbols-outlined text-5xl text-primary">cloud_done</span>
                  </div>
                  <div className="text-left">
                    <p className={`text-sys-lg font-black ${pulseClass}`}>{metrics.online}</p>
                    <p className="text-sys-sm font-bold text-on-surface-variant">在线设备</p>
                  </div>
                </div>
                {/* 连通链路 */}
                <div className="flex items-center gap-6">
                  <div className="w-24 h-24 glass-card rounded-full flex items-center justify-center border-2 border-primary">
                    <span className="material-symbols-outlined text-5xl text-primary">link</span>
                  </div>
                  <div className="text-left">
                    <p className={`text-sys-lg font-black ${pulseClass}`}>{metrics.connected}</p>
                    <p className="text-sys-sm font-bold text-on-surface-variant">连通链路</p>
                  </div>
                </div>
                {/* 严重告警 */}
                <div className="flex items-center gap-6">
                  <div className="w-24 h-24 glass-card rounded-full flex items-center justify-center border-2 border-error">
                    <span className="material-symbols-outlined text-5xl text-error">emergency</span>
                  </div>
                  <div className="text-left">
                    <p className={`text-sys-lg font-black ${pulseClass}`}>{metrics.critical}</p>
                    <p className="text-sys-sm font-bold text-on-surface-variant">严重告警</p>
                  </div>
                </div>
              </div>

            </div>




            {/* Right Panels */}
            <div className="col-span-3 row-span-3 flex flex-col gap-2">
              {/* 告警统计 */}
              <section className="glass-card flex-1 rounded-2xl p-6">
                <h2 className="text-sys-lg font-bold text-primary mb-6 border-l-4 border-primary pl-3">告警状态统计</h2>
                <div className="flex gap-4">
                  <div className="flex-1 flex flex-col items-center">
                    <div className="w-28 h-28 relative flex items-center justify-center mb-2">
                      <svg className="w-full h-full">
                        <circle cx="56" cy="56" fill="transparent" r="48" stroke="#131f37" strokeWidth="12"></circle>
                        <circle cx="56" cy="56" fill="transparent" r="48" stroke="#81ecff" strokeDasharray="301" strokeDashoffset="60" strokeWidth="12"></circle>
                      </svg>
                      <span className="absolute font-bold">{deviceAnomaly}%</span>
                    </div>
                    <p className="font-bold">设备异常率</p>
                  </div>
                  <div className="flex-1 flex flex-col items-center">
                    <div className="w-28 h-28 relative flex items-center justify-center mb-2">
                      <svg className="w-full h-full">
                        <circle cx="56" cy="56" fill="transparent" r="48" stroke="#131f37" strokeWidth="12"></circle>
                        <circle cx="56" cy="56" fill="transparent" r="48" stroke="#6e9bff" strokeDasharray="301" strokeDashoffset="36" strokeWidth="12"></circle>
                      </svg>
                      <span className="absolute font-bold">{linkAnomaly}%</span>
                    </div>
                    <p className="font-bold">链路异常率</p>
                  </div>
                </div>
              </section>

              {/* 根因与修复 */}
              <section className="glass-card flex-1 rounded-2xl p-6">
                <h2 className="text-sys-lg font-bold text-primary mb-6 border-l-4 border-primary pl-3">智能运维效率</h2>
                <div className="space-y-6">
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold">根因分析准确率</span>
                      <span className="text-sys-lg font-black text-tertiary">92.4%</span>
                    </div>
                    <div className="h-4 bg-surface-container-high rounded-full overflow-hidden border border-white/5">
                      <div className="h-full bg-gradient-to-r from-tertiary/40 to-tertiary w-[92%]"></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold">自动修复成功率</span>
                      <span className="text-sys-lg font-black text-primary">64.8%</span>
                    </div>
                    <div className="h-4 bg-surface-container-high rounded-full overflow-hidden border border-white/5">
                      <div className="h-full bg-gradient-to-r from-primary/40 to-primary w-[64%]"></div>
                    </div>
                  </div>
                </div>
              </section>
            </div>




            {/* 一周故障趋势 (扩大为 col-span-5) */}
            <div className="col-span-5 row-span-2 glass-card rounded-2xl p-6 flex flex-col overflow-hidden">
              <header className="flex justify-between items-center mb-6">
                <h2 className="text-sys-lg font-bold text-primary border-l-4 border-primary pl-3">一周故障趋势</h2>
                <div className="flex gap-6 font-bold">
                  <span className="flex items-center gap-2"><span className="w-4 h-4 bg-error"></span> 总故障</span>
                  <span className="flex items-center gap-2"><span className="w-4 h-4 bg-primary"></span> 已修复</span>
                </div>
              </header>
              
              <div className="flex-1 flex gap-2">
                {/* 纵轴：仅标注 100, 50, 0 */}
                <div className="flex flex-col justify-between text-sys-sm font-bold text-on-surface-variant/40 pb-7 pt-1 border-r border-outline/10 pr-2 shrink-0">
                  <span>100</span>
                  <span>50</span>
                  <span>0</span>
                </div>

                {/* 主图表：移除 gap-4，使用 justify-between 实现自适应间隔 */}
                <div className="flex-1 flex items-end justify-between px-1">
                  {[...Array(7)].map((_, idx) => {
                    const d = new Date();
                    d.setDate(d.getDate() - (6 - idx));
                    const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    const heights = [[70,50], [100,70], [90,60], [40,35], [75,70], [30,28], [60,20]];
                    
                    return (
                      <div key={dateStr} className="flex flex-col items-center gap-2">
                        <div className="flex items-end gap-1 h-32">
                          <div className="w-4 sm:w-5 bg-error rounded-t-sm" style={{ height: `${heights[idx][0]}%` }}></div>
                          <div className="w-4 sm:w-5 bg-primary rounded-t-sm" style={{ height: `${heights[idx][1]}%` }}></div>
                        </div>
                        <span className="text-sys-sm font-bold opacity-70 scale-90">{dateStr}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>




            {/* 实时告警列表 */}
            <div className="col-span-7 row-span-2 glass-card rounded-2xl flex flex-col overflow-hidden">
              <header className="p-4 bg-surface-container-high/60 border-b border-primary/20 flex justify-between items-center">
                <h2 className="text-sys-lg font-bold text-primary border-l-4 border-primary pl-3">实时告警信息流</h2>
                <div className="flex gap-8 font-bold">
                  <span className="text-error">● 12 严重告警</span>
                  <span className="text-secondary">● 27 待处理</span>
                </div>
              </header>
              {/* 修改处：将 auto-scroll-container 替换为 overflow-y-auto 和 custom-scrollbar */}
              <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="auto-scroll-content">
                  <table className="w-full text-left border-separate border-spacing-y-3 px-6">

                    <thead className="sticky top-0 bg-[#091327] z-10 text-on-surface-variant font-bold">
                      <tr>
                        <th className="py-2">点位名称</th>
                        <th className="py-2">SSRC</th>
                        <th className="py-2">故障类型</th>
                        <th className="py-2">级别</th>
                        <th className="py-2">发生时间</th>
                        <th className="py-2 text-center">状态</th>
                      </tr>
                    </thead>



                    <tbody>
                      {faultEvents.map((event, index) => {
                        const pointName = event.pointName || "未知设备";
                        const ssrc = event.ssrc || "N/A";
                        const faultType = event.faultType || "未知故障";
                        const levelStr = String(event.level || "次要");
                        
                        // 2. 故障等级动态样式计算（完全复用原有设计体系）
                        let levelClass = "bg-on-surface-variant/20 text-on-surface-variant border-outline/50";
                        let levelText = "次要";
                        if (levelStr.includes('严重') || levelStr === 'critical') {
                          levelClass = "bg-error/20 text-error border-error/50";
                          levelText = "严重";
                        } else if (levelStr.includes('主要') || levelStr === 'major') {
                          levelClass = "bg-secondary/20 text-secondary border-secondary/50";
                          levelText = "主要";
                        }

                        const timeStr = event.time || "";

                        const isResolved = event.status === 'resolved' || event.status === '已恢复' || event.status === '已解决';

                        return (
                          <tr key={event.id || index} className="bg-surface-container-low/50 hover:bg-primary/10 transition-colors">
                            <td className="py-3 pl-4">{pointName}</td>
                            <td className="font-mono text-primary/80">{ssrc}</td>
                            <td>{faultType}</td>
                            <td>
                              <span className={`${levelClass} px-3 py-1 rounded-full text-sys-sm font-black border`}>
                                {levelText}
                              </span>
                            </td>
                            <td className="text-on-surface-variant">{timeStr}</td>
                            <td className="text-center">
                              {isResolved ? (
                                <span className="material-symbols-outlined text-primary">check</span>
                              ) : (
                                <span className="material-symbols-outlined text-error">close</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {faultEvents.length === 0 && (
                        <tr>
                          <td colSpan="6" className="py-8 text-center text-on-surface-variant/50">正在加载或暂无告警数据...</td>
                        </tr>
                      )}
                    </tbody>



                  </table>
                </div>
              </div>
            </div>


            
          </div>
          )}

          {/* 2. 拓扑页面：只有当 activeTab 为 'topology' 时才显示 */}
          {activeTab === 'topology' && (<TopologyManagement />)}

          {activeTab === 'device' && (<DeviceInformation />)}

          {activeTab === 'alarm' && (<AnomalyDetection onStartRootCause={handleStartRootCause} />)}

          {activeTab === 'rootcause' && <RootCauseAnalysis incomingFault={rootCauseRequest} />}

          {activeTab === 'repair' && <FaultRepair />}

        </main>

        {/* UI Overlays */}
        <div className="fixed inset-0 pointer-events-none border-surface-container-lowest opacity-40 z-0"></div>
        <div className="fixed top-0 left-0 w-full h-full bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-[0.04] pointer-events-none z-0"></div>

        </div>
      </div>
    </div>
  )
}

export default App
