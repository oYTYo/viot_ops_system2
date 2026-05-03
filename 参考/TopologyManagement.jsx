import React, { useEffect, useRef, useState } from 'react';
import AMapLoader from '@amap/amap-jsapi-loader';
import CameraDetailModal from './CameraDetailModal';
import ServerDetailModal from './ServerDetailModal';

// --- 配置区 ---
import { AMAP_KEY } from '../amap_config';
import { API_BASE_URLS } from '../api/client';


// --- 工具函数 (复用自 DeviceInformation) ---
const toNullableText = (value) => {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return (!text || text === '--') ? null : text;
};
const toNullableFloat = (value) => {
  const text = toNullableText(value);
  if (text === null) return null;
  const num = Number.parseFloat(text.replace('%', ''));
  return Number.isFinite(num) ? num : null;
};
const toSignedCoordinate = (value, dir, axis) => {
  const numeric = toNullableFloat(value);
  if (numeric === null) return null;
  const abs = Math.abs(numeric);
  const useDir = (dir || (axis === 'longitude' ? 'E' : 'N')).toUpperCase();
  const negative = axis === 'longitude' ? useDir === 'W' : useDir === 'S';
  return negative ? -abs : abs;
};



const TopologyManagement = () => {
  const mapRef = useRef(null);


  const requestWithBaseFallback = async (path, options = {}) => {
    let lastError = null;

    for (let i = 0; i < API_BASE_URLS.length; i += 1) {
      const base = API_BASE_URLS[i];
      try {
        const res = await fetch(`${base}${path}`, {
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
          },
          ...options
        });

        if (res.status === 404 && i < API_BASE_URLS.length - 1) {
          continue;
        }

        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const err = await res.json();
            detail = err?.detail || detail;
          } catch {
            detail = res.statusText || detail;
          }
          throw new Error(detail);
        }

        if (res.status === 204) return null;
        return res.json();
      } catch (error) {
        lastError = error;
        if (i === API_BASE_URLS.length - 1) throw error;
      }
    }

    throw lastError || new Error('Request failed');
  };

  // 控制弹窗展现的状态
  const [selectedCameraId, setSelectedCameraId] = useState(null);
  const [selectedServerData, setSelectedServerData] = useState(null);

  const mapInstanceRef = useRef(null);
  const isAddingModeRef = useRef(false); // 使用 ref 避免闭包内拿不到最新状态
  const [isAddingMode, setIsAddingMode] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [activeTab, setActiveTab] = useState('camera');
  const [formData, setFormData] = useState({});
  const [serversList, setServersList] = useState([]); // 存下来用于下拉框
  const [refreshKey, setRefreshKey] = useState(0); // 用于触发组件内数据重刷


  // 1. 初始化地图
  useEffect(() => {
    let disposed = false;

    const init = async () => {
      try {
        const [AMap, cameras, servers] = await Promise.all([
          AMapLoader.load({
            key: AMAP_KEY,
            version: "2.0",
            plugins: ['AMap.MarkerClusterer', 'AMap.Polyline', 'AMap.MoveAnimation'],
          }),
          requestWithBaseFallback('/cameras'),
          requestWithBaseFallback('/servers'),
        ]);
        if (disposed) return;

        const serverArray = Array.isArray(servers) ? servers : [];
        setServersList(serverArray); // 保存以便给表单里的下拉框使用

        const map = new AMap.Map(mapRef.current, {
          zoom: 13,
          center: [118.1467, 24.5126], // 厦门湖里区中心
          viewMode: '3D',
          mapStyle: 'amap://styles/darkblue', // 极简暗色风格
        });
        mapInstanceRef.current = map;

        // --- 提取全局缩放比例计算函数（完全复用知识图谱页面的逻辑） ---
        const getScale = () => Math.min(window.innerWidth / 1920, window.innerHeight / 1080);

        // 绑定地图点击事件（获取经纬度并弹窗）
        map.on('click', (e) => {
          if (isAddingModeRef.current) {
            
            // --- 核心修复：消除 CSS scale 导致的鼠标点击偏移 ---
            const scale = getScale();
            const rect = mapRef.current.getBoundingClientRect();
            
            // 1. 基于浏览器原生鼠标事件，计算出抵消 scale 后的真实逻辑像素坐标
            const truePixelX = (e.originEvent.clientX - rect.left) / scale;
            const truePixelY = (e.originEvent.clientY - rect.top) / scale;
            
            // 2. 调用 AMap 内置方法，将修正后的准确像素点转换为经纬度
            const trueLngLat = map.containerToLngLat(new AMap.Pixel(truePixelX, truePixelY));
            
            const lng = trueLngLat.getLng();
            const lat = trueLngLat.getLat();
            // ---------------------------------------------------

            setFormData({
              longitude: Math.abs(lng).toFixed(6),
              longitudeDir: lng < 0 ? 'W' : 'E',
              latitude: Math.abs(lat).toFixed(6),
              latitudeDir: lat < 0 ? 'S' : 'N',
              status: '在线', 
              protocol: 'TCP', 
              streamType: '主码流',
              nodeType: '流媒体服务'
            });
            setActiveTab('camera'); // 默认先展示摄像机TAB
            setShowAddModal(true);
            toggleAddMode(); // 选完点后自动关闭十字光标模式
          }
        });

        // 绘制设备与连线
        renderDevices(AMap, map, serverArray, Array.isArray(cameras) ? cameras : []);
      } catch (error) {
        console.error('Topology data load failed:', error);
      }
    };

    init();

    return () => {
      disposed = true;
    };
  }, [refreshKey]);

  const renderDevices = (AMap, map, servers, cameras) => {
    // 渲染服务器节点
    servers.forEach(s => {
      if (typeof s.longitude !== 'number' || typeof s.latitude !== 'number') return;
      const serverPos = [s.longitude, s.latitude];
      const marker = new AMap.Marker({
        position: serverPos,
        content: `<div class="w-12 h-12 rounded-full bg-tertiary/20 border-2 border-tertiary flex items-center justify-center shadow-[0_0_25px_rgba(203,123,255,0.8)] cursor-pointer hover:scale-110 transition-transform">
                    <span class="material-symbols-outlined text-tertiary text-3xl">storage</span>
                  </div>`,
        title: s.name,
        offset: new AMap.Pixel(-24, -24)
      });
      
      // 绑定点击事件：打开服务器弹窗
      marker.on('click', () => {
        setSelectedServerData(s);
      });
      map.add(marker);
    });

    // 渲染摄像头并连线
    cameras.forEach(c => {
      if (typeof c.longitude !== 'number' || typeof c.latitude !== 'number') return;
      const cameraPos = [c.longitude, c.latitude];

      // --- 1. 渲染摄像头节点 (无论是否绑定服务器都画出来) ---
      const cameraMarker = new AMap.Marker({
        position: cameraPos,
        content: `<div class="w-10 h-10 rounded-full bg-primary/20 border-2 border-primary/80 flex items-center justify-center hover:scale-110 transition-transform shadow-[0_0_15px_rgba(129,236,255,0.5)] cursor-pointer">
                    <span class="material-symbols-outlined text-primary text-xl">videocam</span>
                  </div>`,
        offset: new AMap.Pixel(-20, -20),
        zIndex: 100
      });
      cameraMarker.on('click', () => setSelectedCameraId(c.id));
      map.add(cameraMarker);

      // --- 2. 渲染连线与粒子 (仅当绑定了有效的服务器时执行) ---
      const server = servers.find(s => s.id === c.server_id);
      if (server && typeof server.longitude === 'number' && typeof server.latitude === 'number') {
        const serverPos = [server.longitude, server.latitude];
        
        // 连线
        const polyline = new AMap.Polyline({
          path: [cameraPos, serverPos],
          strokeColor: "#81ecff",
          strokeOpacity: 0.6,
          strokeWeight: 2,
          strokeStyle: "dashed",
          showDir: true,
        });
        map.add(polyline);

        // 发光粒子
        const flowParticle = new AMap.Marker({
          position: cameraPos,
          content: `<div class="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_10px_3px_rgba(129,236,255,0.9)]"></div>`,
          offset: new AMap.Pixel(-3, -3),
          zIndex: 10
        });
        map.add(flowParticle);
        flowParticle.moveAlong([cameraPos, serverPos], { speed: 2500, circlable: true });
      }
    });


  };

  const toggleAddMode = () => {
    const newMode = !isAddingModeRef.current;
    isAddingModeRef.current = newMode;
    setIsAddingMode(newMode);
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setDefaultCursor(newMode ? 'crosshair' : '');
    }
  };

  const handleInputChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSubmit = async () => {
    const normalizedFormData = {
      ...formData,
      status: formData.status || (activeTab === 'camera' ? '在线' : '正常'),
      protocol: formData.protocol || 'TCP',
      streamType: formData.streamType || '主码流',
      nodeType: formData.nodeType || '流媒体服务'
    };
    const requiredFields = activeTab === 'camera' ? ['id', 'name', 'ip'] : ['id', 'name', 'ip', 'nodeType'];
    const missing = requiredFields.filter((f) => {
      const v = normalizedFormData[f];
      return v === null || v === undefined || String(v).trim() === '';
    });
    if (missing.length > 0) {
      alert('请填写所有带 * 的必填项');
      return;
    }

    try {
      if (activeTab === 'camera') {
        const createPayload = {
          id: normalizedFormData.id,
          name: normalizedFormData.name,
          model: toNullableText(normalizedFormData.model),
          ip: normalizedFormData.ip,
          status: normalizedFormData.status || '在线',
          protocol: normalizedFormData.protocol,
          codec: toNullableText(normalizedFormData.codec),
          stream_type: toNullableText(normalizedFormData.streamType),
          unit: toNullableText(normalizedFormData.unit),
          manager: toNullableText(normalizedFormData.manager),
          location_desc: toNullableText(normalizedFormData.locationDesc),
          longitude: toSignedCoordinate(normalizedFormData.longitude, normalizedFormData.longitudeDir, 'longitude'),
          latitude: toSignedCoordinate(normalizedFormData.latitude, normalizedFormData.latitudeDir, 'latitude'),
          server_id: toNullableText(normalizedFormData.serverId),
          video_url: toNullableText(normalizedFormData.videoUrl)
        };
        await requestWithBaseFallback('/cameras', { method: 'POST', body: JSON.stringify(createPayload) });
      } else {
        const createPayload = {
          id: normalizedFormData.id,
          name: normalizedFormData.name,
          ip: normalizedFormData.ip,
          node_type: normalizedFormData.nodeType,
          status: normalizedFormData.status || '正常',
          location_desc: toNullableText(normalizedFormData.locationDesc),
          longitude: toSignedCoordinate(normalizedFormData.longitude, normalizedFormData.longitudeDir, 'longitude'),
          latitude: toSignedCoordinate(normalizedFormData.latitude, normalizedFormData.latitudeDir, 'latitude'),
          cpu_usage: toNullableFloat(normalizedFormData.cpuUsage),
          ram_usage: toNullableFloat(normalizedFormData.ramUsage),
          disk_usage: toNullableFloat(normalizedFormData.diskUsage),
          net_bandwidth: toNullableFloat(normalizedFormData.netBandwidth),
          gpu_usage: toNullableFloat(normalizedFormData.gpuUsage)
        };
        await requestWithBaseFallback('/servers', { method: 'POST', body: JSON.stringify(createPayload) });
      }
      setShowAddModal(false);
      // 使用最轻量的刷新方法重新加载地图点位线束
      setRefreshKey(prev => prev + 1); // 仅触发组件内部重刷，不会丢失当前页面状态
    } catch (error) {
      console.error('Failed to create device:', error);
      alert(`创建失败：${error.message}`);
    }
  };



  return (
    <div className="flex-1 flex gap-6 p-6 h-full overflow-hidden">
      {/* 左侧信息栏 (25%) */}
      <div className="w-[450px] flex flex-col gap-6 shrink-0">
        <MetricCard title="设备接入状态" value="1,240" subValue="1,152 在线" percent={92.9} color="primary" icon="videocam" />
        <MetricCard title="流链路状态" value="4,020" subValue="3,880 连通" percent={96.5} color="secondary" icon="lan" />
        <MetricCard title="服务器负载" value="12" subValue="10 使用中" percent={83.3} color="tertiary" icon="dns" />
        <DevicePieCard />
      </div>

      {/* 右侧地图区 (75%) */}
      <div className="flex-1 relative glass-card rounded-3xl overflow-hidden border border-primary/10">
        <div ref={mapRef} className="w-full h-full" />
        <div className="absolute top-6 left-10 pointer-events-none">
          <h2 className="text-sys-lg font-black text-primary drop-shadow-md">福建省厦门市湖里区</h2>
          <p className="text-sys-sm font-bold text-on-surface-variant opacity-70">拓扑节点分布图 • 实时监控中</p>
        </div>
        
        {/* 设备悬浮按钮 */}
        <button
          onClick={toggleAddMode}
          className={`absolute top-6 right-10 flex items-center gap-2 px-4 py-2 rounded-lg font-bold transition-all text-sys-sm shadow-lg border ${
            isAddingMode 
              ? 'bg-error text-background border-error/50 hover:bg-error/80' 
              : 'bg-surface-container-high/80 backdrop-blur-md text-on-surface border-outline/30 hover:border-primary hover:text-primary'
          }`}
        >
          <span className="material-symbols-outlined">{isAddingMode ? 'close' : 'add_location_alt'}</span>
          {isAddingMode ? '取消选取坐标' : '在地图上选点新建'}
        </button>
      </div>




      {/* 弹窗组件：增加了 key 属性强制重新挂载，防止切换设备时数据不更新 */}
      <CameraDetailModal 
        key={selectedCameraId || 'cam-modal'}
        cameraId={selectedCameraId} 
        isOpen={!!selectedCameraId} 
        onClose={() => setSelectedCameraId(null)} 
        serversList={serversList}
        onSuccess={() => setRefreshKey(prev => prev + 1)} // 新增：保存成功后的刷新回调
      />



      <ServerDetailModal 
        key={selectedServerData?.id || 'srv-modal'}
        serverData={selectedServerData} 
        isOpen={!!selectedServerData} 
        onClose={() => setSelectedServerData(null)} 
      />



      {/* --- 新建设备表单 Modal --- */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass-card border border-primary/30 w-[860px] rounded-2xl p-6 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex justify-between items-center mb-4 shrink-0 border-l-4 border-primary pl-2">
              <h2 className="text-sys-lg font-black text-primary">在地图上新建设备</h2>
              
              {/* 设备类型切换 */}
              <div className="flex gap-2 bg-surface-container-low p-1 rounded-lg border border-outline/20">
                <button 
                  onClick={() => setActiveTab('camera')}
                  className={`px-4 py-1.5 rounded-md font-bold transition-all text-sys-sm ${activeTab === 'camera' ? 'bg-primary/20 text-primary border border-primary/50' : 'text-on-surface-variant hover:text-on-surface'}`}
                >摄像机设备</button>
                <button 
                  onClick={() => setActiveTab('server')}
                  className={`px-4 py-1.5 rounded-md font-bold transition-all text-sys-sm ${activeTab === 'server' ? 'bg-secondary/20 text-secondary border border-secondary/50' : 'text-on-surface-variant hover:text-on-surface'}`}
                >边缘/流媒体服务器</button>
              </div>
            </div>
            
            {/* 表单滚动区 */}
            <div className="flex-1 overflow-y-auto pr-2 no-scrollbar flex flex-col gap-4">
              {activeTab === 'camera' ? (
                <>
                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-primary rounded-full block"></span>设备基础信息
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">设备ID <span className="text-error">*</span></label>
                        <input name="id" value={formData.id || ''} placeholder="CAM-RD-101" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">设备名称 <span className="text-error">*</span></label>
                        <input name="name" value={formData.name || ''} placeholder="如：学院路路口监控1" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">状态</label>
                        <select name="status" value={formData.status || '在线'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="在线">在线</option><option value="故障">故障</option><option value="离线">离线</option>
                        </select>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">设备型号</label>
                        <input name="model" value={formData.model || ''} placeholder="如：海康 iDS-2VS" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                      
                      {/* -- 你要求的服务器下拉框改造在此处 -- */}
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">绑定服务器ID</label>
                        <select name="serverId" value={formData.serverId || ''} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="">-- 请选择关联的服务器 --</option>
                          {serversList.map(s => (
                            <option key={s.id} value={s.id}>{s.name ? `${s.name} (${s.id})` : s.id}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-primary rounded-full block"></span>网络与编码参数
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">IP地址 <span className="text-error">*</span></label>
                        <input name="ip" value={formData.ip || ''} placeholder="192.168.10.11" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">传输协议</label>
                        <select name="protocol" value={formData.protocol || 'TCP'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="TCP">TCP</option><option value="UDP">UDP</option>
                        </select>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">码流类型</label>
                        <select name="streamType" value={formData.streamType || '主码流'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="主码流">主码流</option><option value="子码流">子码流</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-primary rounded-full block"></span>位置信息 (已自动拾取)
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">经度</label>
                        <div className="flex gap-2">
                          <input name="longitude" value={formData.longitude ?? ''} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-full text-sys-sm cursor-not-allowed" />
                          <input value={formData.longitudeDir === 'W' ? '西' : '东'} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-16 text-center text-sys-sm cursor-not-allowed" />
                        </div>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">纬度</label>
                        <div className="flex gap-2">
                          <input name="latitude" value={formData.latitude ?? ''} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-full text-sys-sm cursor-not-allowed" />
                          <input value={formData.latitudeDir === 'S' ? '南' : '北'} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-16 text-center text-sys-sm cursor-not-allowed" />
                        </div>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">位置描述</label>
                        <input name="locationDesc" value={formData.locationDesc || ''} placeholder="在此补充具体的位置文本描述..." onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* 服务器新增表单块 */}
                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-secondary rounded-full block"></span>服务器基础信息
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">服务器ID <span className="text-error">*</span></label>
                        <input name="id" value={formData.id || ''} placeholder="SVR-BJ-01" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">服务器名称 <span className="text-error">*</span></label>
                        <input name="name" value={formData.name || ''} placeholder="如：核心流媒体节点A" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">节点类型 <span className="text-error">*</span></label>
                        <select name="nodeType" value={formData.nodeType || '流媒体服务'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="流媒体服务">流媒体服务</option><option value="数据库服务">数据库服务</option><option value="接入网关">接入网关</option>
                        </select>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">IP地址 <span className="text-error">*</span></label>
                        <input name="ip" value={formData.ip || ''} placeholder="192.168.10.11" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-secondary rounded-full block"></span>位置信息 (已自动拾取)
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">经度</label>
                        <div className="flex gap-2">
                          <input name="longitude" value={formData.longitude ?? ''} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-full text-sys-sm cursor-not-allowed" />
                          <input value={formData.longitudeDir === 'W' ? '西' : '东'} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-16 text-center text-sys-sm cursor-not-allowed" />
                        </div>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">纬度</label>
                        <div className="flex gap-2">
                          <input name="latitude" value={formData.latitude ?? ''} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-full text-sys-sm cursor-not-allowed" />
                          <input value={formData.latitudeDir === 'S' ? '南' : '北'} readOnly className="bg-surface-container-highest border border-outline/10 text-on-surface-variant rounded-lg px-3 py-2 w-16 text-center text-sys-sm cursor-not-allowed" />
                        </div>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">机房/位置描述</label>
                        <input name="locationDesc" value={formData.locationDesc || ''} placeholder="如：核心机房-A架" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-4 shrink-0 pt-4 border-t border-outline/10 mt-4">
              <button onClick={() => setShowAddModal(false)} className="px-6 py-2 rounded-lg border border-outline/50 hover:bg-outline/10 text-on-surface font-bold transition-colors text-sys-sm">取消</button>
              <button onClick={handleSubmit} className="px-6 py-2 rounded-lg bg-primary text-background font-bold hover:bg-primary/80 transition-colors text-sys-sm">确认添加</button>
            </div>
          </div>
        </div>
      )}



    </div>
  );
};

// --- 通用仪表盘组件 ---
const MetricCard = ({ title, value, subValue, percent, color, icon }) => (
  <section className="glass-card flex-1 rounded-2xl p-6 flex flex-col justify-between relative overflow-hidden">
    <div className="flex justify-between items-center z-10">
      <h3 className="text-sys-sm font-bold text-on-surface-variant border-l-4 pl-3" style={{ borderColor: `var(--${color})` }}>{title}</h3>
      <span className="material-symbols-outlined text-3xl opacity-30" style={{ color: `var(--${color})` }}>{icon}</span>
    </div>
    <div className="flex items-center gap-8 mt-2">
      <div className="relative w-28 h-28 flex items-center justify-center">
        <svg className="absolute inset-0 transform -rotate-90">
          <circle cx="56" cy="56" r="48" fill="transparent" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
          <circle cx="56" cy="56" r="48" fill="transparent" stroke={`var(--${color})`} strokeWidth="8" 
                  strokeDasharray="301" strokeDashoffset={301 * (1 - percent / 100)} />
        </svg>
        <span className="text-sys-lg font-black text-on-surface">{percent}%</span>
      </div>
      <div>
        <p className="text-5xl font-black text-on-surface leading-tight">{value}</p>
        <p className="text-sys-sm font-bold text-on-surface-variant">{subValue}</p>
      </div>
    </div>
  </section>
);

// --- 饼图组件 ---
const DevicePieCard = () => (
  <section className="glass-card flex-1 rounded-2xl p-6 flex flex-col">
    <h3 className="text-sys-sm font-bold text-[#A2ABC3] mb-6 border-l-4 border-[#A2ABC3] pl-3">设备类型占比</h3>
    <div className="flex items-center gap-8 flex-1">
      {/* 镂空环形图区域 */}
      <div className="w-28 h-28 relative">
         <svg viewBox="0 0 32 32" className="w-full h-full transform -rotate-90">
            <circle r="14" cx="16" cy="16" fill="transparent" stroke="rgba(255,255,255,0.05)" strokeWidth="4" />
            <circle r="14" cx="16" cy="16" fill="transparent" stroke="#81ecff" strokeWidth="4" strokeDasharray="61.57 87.96" />
            <circle r="14" cx="16" cy="16" fill="transparent" stroke="#6e9bff" strokeWidth="4" strokeDasharray="21.99 87.96" strokeDashoffset="-61.57" />
            <circle r="14" cx="16" cy="16" fill="transparent" stroke="#cb7bff" strokeWidth="4" strokeDasharray="4.40 87.96" strokeDashoffset="-83.56" />
         </svg>
      </div>
      
      {/* 图例区域 */}
      <div className="flex-1 space-y-3 font-bold">
        <div className="flex justify-between"><span className="text-[#81ecff]">摄像头</span><span>70%</span></div>
        <div className="flex justify-between"><span className="text-[#6e9bff]">NVR</span><span>25%</span></div>
        <div className="flex justify-between"><span className="text-[#cb7bff]">服务器</span><span>5%</span></div>
      </div>
    </div>
  </section>
);

export default TopologyManagement;
