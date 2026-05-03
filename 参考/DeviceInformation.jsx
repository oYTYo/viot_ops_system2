import React, { useEffect, useState } from 'react';
import CameraDetailModal from '../pages/CameraDetailModal';
import ServerDetailModal from '../pages/ServerDetailModal';
import { requestWithFallback } from '../api/client';


// --- 模拟数据 ---
const DeviceInformation = () => {

  // 将 mock 数据存入状态以支持新增展示
  const [cameras, setCameras] = useState([]);
  const [servers, setServers] = useState([]);
  const [formData, setFormData] = useState({}); // 表单输入数据
  const normalizeText = (value) => (value === null || value === undefined || value === '' ? '--' : String(value));
  const toNullableText = (value) => {
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (!text || text === '--') return null;
    return text;
  };
  const toNullableFloat = (value) => {
    const text = toNullableText(value);
    if (text === null) return null;
    const num = Number.parseFloat(text.replace('%', ''));
    return Number.isFinite(num) ? num : null;
  };
  const inferLongitudeDir = (value) => (value !== null && value !== undefined && Number(value) < 0 ? 'W' : 'E');
  const inferLatitudeDir = (value) => (value !== null && value !== undefined && Number(value) < 0 ? 'S' : 'N');
  const toSignedCoordinate = (value, dir, axis) => {
    const numeric = toNullableFloat(value);
    if (numeric === null) return null;
    const abs = Math.abs(numeric);
    const useDir = (dir || (axis === 'longitude' ? 'E' : 'N')).toUpperCase();
    const negative = axis === 'longitude' ? useDir === 'W' : useDir === 'S';
    return negative ? -abs : abs;
  };
  const formatLongitude = (value) => {
    if (value === null || value === undefined || value === '') return '--';
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    return `${Math.abs(num).toFixed(2)}°${num < 0 ? 'W' : 'E'}`;
  };
  const formatLatitude = (value) => {
    if (value === null || value === undefined || value === '') return '--';
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    return `${Math.abs(num).toFixed(2)}°${num < 0 ? 'S' : 'N'}`;
  };
  const buildLocationText = (longitude, latitude, locationDesc) => {
    const hasGeo = longitude !== null && longitude !== undefined && latitude !== null && latitude !== undefined;
    const geoText = hasGeo ? `${formatLongitude(longitude)}, ${formatLatitude(latitude)}` : '';
    const descText = toNullableText(locationDesc) || '';
    if (geoText && descText) return `${geoText} / ${descText}`;
    return geoText || descText || '--';
  };
  const toCameraViewModel = (item) => ({
    id: normalizeText(item.id),
    name: normalizeText(item.name),
    ip: normalizeText(item.ip),
    status: item.status || '在线',
    protocol: item.protocol || 'TCP',
    model: item.model ?? '',
    location: buildLocationText(item.longitude, item.latitude, item.location_desc),
    locationDesc: item.location_desc ?? '',
    longitude: item.longitude ?? '',
    latitude: item.latitude ?? '',
    longitudeDir: inferLongitudeDir(item.longitude),
    latitudeDir: inferLatitudeDir(item.latitude),
    unit: item.unit ?? '',
    manager: item.manager ?? '',
    codec: item.codec ?? '',
    streamType: item.stream_type ?? '',
    serverId: item.server_id ?? '',
    faultDetail: '--',
    videoUrl: item.video_url ?? ''
  });
  const toServerViewModel = (item) => ({
    id: normalizeText(item.id),
    name: item.name ?? '',
    ip: normalizeText(item.ip),
    status: item.status || '正常',
    nodeType: item.node_type || '流媒体服务',
    location: buildLocationText(item.longitude, item.latitude, item.location_desc),
    locationDesc: item.location_desc ?? '',
    longitude: item.longitude ?? '',
    latitude: item.latitude ?? '',
    longitudeDir: inferLongitudeDir(item.longitude),
    latitudeDir: inferLatitudeDir(item.latitude),
    cpuUsage: item.cpu_usage ?? '',
    ramUsage: item.ram_usage ?? '',
    diskUsage: item.disk_usage ?? '',
    netBandwidth: item.net_bandwidth ?? '',
    gpuUsage: item.gpu_usage ?? '',
    cpu: item.cpu_usage === null || item.cpu_usage === undefined ? '--' : `${item.cpu_usage}%`,
    ram: item.ram_usage === null || item.ram_usage === undefined ? '--' : `${item.ram_usage}%`,
    disk: item.disk_usage === null || item.disk_usage === undefined ? '--' : `${item.disk_usage}%`,
    netBandwidthText: item.net_bandwidth === null || item.net_bandwidth === undefined ? '--' : String(item.net_bandwidth),
    gpuUsageText: item.gpu_usage === null || item.gpu_usage === undefined ? '--' : String(item.gpu_usage)
  });


  const [activeTab, setActiveTab] = useState('camera');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCameraId, setSelectedCameraId] = useState(null);
  const [selectedServerData, setSelectedServerData] = useState(null);
  
  // 弹窗状态控制
  const [showAddModal, setShowAddModal] = useState(false);
  const [detailModalData, setDetailModalData] = useState(null);

  const [editMode, setEditMode] = useState(false); // 区分新增和编辑状态

  useEffect(() => {
    const fetchDeviceData = async () => {
      try {
        const [cameraData, serverData] = await Promise.all([
          requestWithFallback('/cameras'),
          requestWithFallback('/servers')
        ]);
        setCameras((Array.isArray(cameraData) ? cameraData : []).map(toCameraViewModel));
        setServers((Array.isArray(serverData) ? serverData : []).map(toServerViewModel));
      } catch (error) {
        console.error('Failed to fetch device list:', error);
        alert(`加载设备列表失败：${error.message}`);
      }
    };

    fetchDeviceData();
  }, []);


// 2. 表单与增删改逻辑
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

        const updatePayload = {
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

        const url = editMode
          ? `/cameras/${encodeURIComponent(normalizedFormData.id)}`
          : '/cameras';

        const saved = toCameraViewModel(await requestWithFallback(url, {
          method: editMode ? 'PUT' : 'POST',
          body: JSON.stringify(editMode ? updatePayload : createPayload)
        }));
        setCameras((prev) => (editMode ? prev.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...prev]));
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

        const updatePayload = {
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

        const url = editMode
          ? `/servers/${encodeURIComponent(normalizedFormData.id)}`
          : '/servers';

        const saved = toServerViewModel(await requestWithFallback(url, {
          method: editMode ? 'PUT' : 'POST',
          body: JSON.stringify(editMode ? updatePayload : createPayload)
        }));
        setServers((prev) => (editMode ? prev.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...prev]));
      }

      setShowAddModal(false);
    } catch (error) {
      console.error('Failed to submit device form:', error);
      alert(`提交失败：${error.message}`);
    }
  };

  const handleEdit = (item) => {
    if (activeTab === 'camera') {
      setFormData({
        ...item,
        status: item.status && item.status !== '--' ? item.status : '在线',
        protocol: item.protocol && item.protocol !== '--' ? item.protocol : 'TCP',
        model: item.model || '',
        codec: item.codec || '',
        streamType: item.streamType || '主码流',
        unit: item.unit || '',
        manager: item.manager || '',
        locationDesc: item.locationDesc || '',
        longitude: item.longitude ?? '',
        latitude: item.latitude ?? '',
        longitudeDir: item.longitudeDir || inferLongitudeDir(item.longitude),
        latitudeDir: item.latitudeDir || inferLatitudeDir(item.latitude),
        serverId: item.serverId || '',
        videoUrl: item.videoUrl || ''
      });
    } else {
      setFormData({
        ...item,
        status: item.status && item.status !== '--' ? item.status : '正常',
        nodeType: item.nodeType && item.nodeType !== '--' ? item.nodeType : '流媒体服务',
        name: item.name || '',
        locationDesc: item.locationDesc || '',
        longitude: item.longitude ?? '',
        latitude: item.latitude ?? '',
        longitudeDir: item.longitudeDir || inferLongitudeDir(item.longitude),
        latitudeDir: item.latitudeDir || inferLatitudeDir(item.latitude),
        cpuUsage: item.cpuUsage ?? '',
        ramUsage: item.ramUsage ?? '',
        diskUsage: item.diskUsage ?? '',
        netBandwidth: item.netBandwidth ?? '',
        gpuUsage: item.gpuUsage ?? ''
      });
    }
    setEditMode(true);
    setShowAddModal(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm(`确认删除设备 ${id} 吗？该操作不可恢复。`)) {
      return;
    }

    try {
      const url = activeTab === 'camera'
        ? `/cameras/${encodeURIComponent(id)}`
        : `/servers/${encodeURIComponent(id)}`;

      await requestWithFallback(url, { method: 'DELETE' });

      if (activeTab === 'camera') {
        setCameras((prev) => prev.filter((c) => c.id !== id));
      } else {
        setServers((prev) => prev.filter((s) => s.id !== id));
      }
    } catch (error) {
      console.error('Failed to delete device:', error);
      alert(`删除失败：${error.message}`);
    }
  };

  const openAddModal = () => {
    setFormData(
      activeTab === 'camera'
        ? { status: '在线', protocol: 'TCP', streamType: '主码流', longitudeDir: 'E', latitudeDir: 'N' }
        : { status: '正常', nodeType: '流媒体服务', longitudeDir: 'E', latitudeDir: 'N' }
    );
    setEditMode(false);
    setShowAddModal(true);
  };

    // 过滤数据
    const currentData = activeTab === 'camera' ? cameras : servers;
    const filteredData = currentData.filter(item =>
    item.id.toLowerCase().includes(searchQuery.toLowerCase()) || 
    item.location.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-hidden">
      
      {/* 顶部操作栏 */}
      <div className="glass-card rounded-2xl p-4 flex justify-between items-center shrink-0 border border-primary/20">
        {/* 维度切换 Tabs */}
        <div className="flex gap-2 bg-surface-container-low p-1 rounded-lg border border-outline/20">
        
          <button 
            onClick={() => setActiveTab('camera')}
            className={`px-6 py-2 rounded-md font-bold transition-all text-sys-sm ${activeTab === 'camera' ? 'bg-primary/20 text-primary border border-primary/50' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            摄像机设备
          </button>

          <button 
            onClick={() => setActiveTab('server')}
            className={`px-6 py-2 rounded-md font-bold transition-all text-sys-sm ${activeTab === 'server' ? 'bg-secondary/20 text-secondary border border-secondary/50' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            边缘/流媒体服务器
          </button>

        </div>

        {/* 搜索与新增 */}
        <div className="flex gap-4 items-center">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
            <input 
              type="text" 
              placeholder="输入ID或位置检索..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:border-primary transition-colors text-sys-sm w-64"
            />
          </div>
          <button 
            onClick={openAddModal}
            className="flex items-center gap-2 bg-primary text-background px-4 py-2 rounded-lg font-bold hover:bg-primary/80 transition-colors text-sys-sm"
          >
            <span className="material-symbols-outlined">add</span>
            新增设备
          </button>
        </div>
      </div>

      {/* 列表内容区 */}
      <div className="glass-card flex-1 rounded-2xl overflow-hidden flex flex-col border border-primary/20 relative">
        <div className="flex-1 overflow-auto no-scrollbar">
          <table className="w-full text-left border-separate border-spacing-y-2 px-6 py-4">
            <thead className="sticky top-0 bg-[#091327] z-10 text-on-surface-variant font-bold text-sys-sm">
              <tr>
                <th className="py-3 px-4 border-b border-outline/20">设备ID</th>
                {activeTab === 'camera' ? (
                  <>
                    <th className="py-3 px-4 border-b border-outline/20">设备名称</th>
                    <th className="py-3 px-4 border-b border-outline/20">IP地址</th>
                    <th className="py-3 px-4 border-b border-outline/20">状态</th>
                    <th className="py-3 px-4 border-b border-outline/20">传输协议</th>
                  </>
                ) : (
                  <>
                    <th className="py-3 px-4 border-b border-outline/20">IP地址</th>
                    <th className="py-3 px-4 border-b border-outline/20">状态</th>
                    <th className="py-3 px-4 border-b border-outline/20">CPU负载</th>
                    <th className="py-3 px-4 border-b border-outline/20">内存</th>
                    <th className="py-3 px-4 border-b border-outline/20">磁盘</th>
                    <th className="py-3 px-4 border-b border-outline/20">机房位置</th>
                    <th className="py-3 px-4 border-b border-outline/20">节点类型</th>
                  </>
                )}
                <th className="py-3 px-4 border-b border-outline/20 text-center">操作 (详情)</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.map((item) => (
                <tr key={item.id} className="bg-surface-container-low/60 hover:bg-primary/10 transition-colors group">
                  <td className="py-3 px-4 font-mono text-primary/90 font-bold">{item.id}</td>
                  
                  {activeTab === 'camera' ? (
                    <>
                      <td className="py-3 px-4 font-bold text-on-surface">{item.name}</td>
                      <td className="py-3 px-4 font-mono text-on-surface-variant">{item.ip}</td>
                      <td className="py-3 px-4">
                        <span className={`px-3 py-1 rounded-full text-sys-sm font-black border ${
                          item.status === '在线' ? 'bg-primary/10 text-primary border-primary/30' : 
                          item.status === '故障' ? 'bg-error/10 text-error border-error/30' : 
                          'bg-outline/10 text-outline border-outline/30'
                        }`}>{item.status}</span>
                      </td>
                      <td className="py-3 px-4 font-bold text-primary">{item.protocol}</td>
                    </>
                  ) : (
                    <>
                      <td className="py-3 px-4 font-mono text-on-surface-variant">{item.ip}</td>
                      <td className="py-3 px-4">
                        <span className={`px-3 py-1 rounded-full text-sys-sm font-black border ${
                          item.status === '正常' ? 'bg-primary/10 text-primary border-primary/30' : 
                          'bg-secondary/10 text-secondary border-secondary/30'
                        }`}>{item.status}</span>
                      </td>
                      <td className={`py-3 px-4 font-bold ${parseInt(item.cpu) > 80 ? 'text-error' : 'text-on-surface'}`}>{item.cpu}</td>
                      <td className="py-3 px-4 text-on-surface">{item.ram}</td>
                      <td className="py-3 px-4 text-on-surface-variant">{item.disk}</td>
                      <td className="py-3 px-4">{item.location}</td>
                      <td className="py-3 px-4 font-bold text-secondary">{item.nodeType}</td>
                    </>
                  )}

                  <td className="py-3 px-4 text-center">
                    <button 
                      onClick={() => {
                        if (activeTab === 'camera') {
                          setSelectedCameraId(item.id);
                        } else {
                          setSelectedServerData(item); // 传入整个服务器数据对象
                        }
                      }}
                      className="text-primary hover:text-primary/70 transition-colors p-2"
                      title="查看详情"
                    >
                      <span className="material-symbols-outlined">info</span>
                    </button>


                    <button onClick={() => handleEdit(item)} className="text-secondary hover:text-secondary/70 transition-colors p-2" title="编辑">
                      <span className="material-symbols-outlined text-sys-sm">edit</span>
                    </button>
                    <button onClick={() => handleDelete(item.id)} className="text-error hover:text-error/70 transition-colors p-2" title="删除">
                      <span className="material-symbols-outlined text-sys-sm">delete</span>
                    </button>


                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredData.length === 0 && (
             <div className="text-center py-20 text-on-surface-variant font-bold">没有找到匹配的设备记录</div>
          )}
        </div>
      </div>



{/* --- 精简版新增/编辑设备 Modal --- */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass-card border border-primary/30 w-[860px] rounded-2xl p-6 shadow-2xl flex flex-col max-h-[700px]">
            <h2 className="text-sys-lg font-black text-primary mb-4 border-l-4 border-primary pl-2 shrink-0">
              {editMode ? '修改' : '新增'} {activeTab === 'camera' ? '摄像机' : '服务器'}
            </h2>
            
            {/* 表单滚动区：与详情页左侧字段统一 */}
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
                        <input name="id" value={formData.id || ''} disabled={editMode} placeholder="CAM-RD-101" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm disabled:opacity-50" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">设备名称 <span className="text-error">*</span></label>
                        <input name="name" value={formData.name || ''} placeholder="如：学院路路口监控1" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">状态</label>
                        <select name="status" value={formData.status || '在线'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="在线">在线</option>
                          <option value="故障">故障</option>
                          <option value="离线">离线</option>
                        </select>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">设备型号</label>
                        <input name="model" value={formData.model || ''} placeholder="如：海康 iDS-2VS" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">绑定服务器ID</label>
                        <input name="serverId" value={formData.serverId || ''} placeholder="可选，如：SVR-BJ-01" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
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
                          <option value="TCP">TCP</option>
                          <option value="UDP">UDP</option>
                        </select>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">编码格式</label>
                        <input name="codec" value={formData.codec || ''} placeholder="H.265 / H.264" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">码流类型</label>
                        <select name="streamType" value={formData.streamType || '主码流'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="主码流">主码流</option>
                          <option value="子码流">子码流</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-primary rounded-full block"></span>管理与运维信息
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">所属单位</label>
                        <input name="unit" value={formData.unit || ''} placeholder="单位名称" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">负责人</label>
                        <input name="manager" value={formData.manager || ''} placeholder="姓名及联系方式" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">经度</label>
                        <div className="flex gap-2">
                          <input name="longitude" value={formData.longitude ?? ''} placeholder="116.397128" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                          <select name="longitudeDir" value={formData.longitudeDir || 'E'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-2 py-2 w-20 text-sys-sm">
                            <option value="E">东</option>
                            <option value="W">西</option>
                          </select>
                        </div>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">纬度</label>
                        <div className="flex gap-2">
                          <input name="latitude" value={formData.latitude ?? ''} placeholder="39.916527" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                          <select name="latitudeDir" value={formData.latitudeDir || 'N'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-2 py-2 w-20 text-sys-sm">
                            <option value="N">北</option>
                            <option value="S">南</option>
                          </select>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">位置描述</label>
                        <input name="locationDesc" value={formData.locationDesc || ''} placeholder="如：学院路与仙岳路交叉口" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-secondary rounded-full block"></span>服务器基础信息
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">服务器ID <span className="text-error">*</span></label>
                        <input name="id" value={formData.id || ''} disabled={editMode} placeholder="SVR-BJ-01" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm disabled:opacity-50" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">服务器名称 <span className="text-error">*</span></label>
                        <input name="name" value={formData.name || ''} placeholder="如：核心流媒体节点A" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">状态</label>
                        <select name="status" value={formData.status || '正常'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="正常">正常</option>
                          <option value="告警">告警</option>
                          <option value="离线">离线</option>
                        </select>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">节点类型 <span className="text-error">*</span></label>
                        <select name="nodeType" value={formData.nodeType || '流媒体服务'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
                          <option value="流媒体服务">流媒体服务</option>
                          <option value="数据库服务">数据库服务</option>
                          <option value="接入网关">接入网关</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10">
                    <h3 className="text-sys-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                      <span className="w-1 h-3.5 bg-secondary rounded-full block"></span>网络与位置
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">IP地址 <span className="text-error">*</span></label>
                        <input name="ip" value={formData.ip || ''} placeholder="192.168.10.11" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">经度</label>
                        <div className="flex gap-2">
                          <input name="longitude" value={formData.longitude ?? ''} placeholder="116.397128" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                          <select name="longitudeDir" value={formData.longitudeDir || 'E'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-2 py-2 w-20 text-sys-sm">
                            <option value="E">东</option>
                            <option value="W">西</option>
                          </select>
                        </div>
                      </div>
                      <div className="col-span-1">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">纬度</label>
                        <div className="flex gap-2">
                          <input name="latitude" value={formData.latitude ?? ''} placeholder="39.916527" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                          <select name="latitudeDir" value={formData.latitudeDir || 'N'} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-2 py-2 w-20 text-sys-sm">
                            <option value="N">北</option>
                            <option value="S">南</option>
                          </select>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sys-sm font-bold text-on-surface-variant mb-1">位置描述</label>
                        <input name="locationDesc" value={formData.locationDesc || ''} placeholder="如：核心机房-A架" onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-lg px-3 py-2 w-full text-sys-sm" />
                      </div>
                    </div>
                  </div>

                </>
              )}
            </div>

            <div className="flex justify-end gap-4 shrink-0 pt-4 border-t border-outline/10 mt-4">
              <button onClick={() => setShowAddModal(false)} className="px-6 py-2 rounded-lg border border-outline/50 hover:bg-outline/10 text-on-surface font-bold transition-colors text-sys-sm">取消</button>
              <button onClick={handleSubmit} className="px-6 py-2 rounded-lg bg-primary text-background font-bold hover:bg-primary/80 transition-colors text-sys-sm">确认提交</button>
            </div>
          </div>
        </div>
      )}




      {/* --- 详情信息 Modal (独立设计预留) --- */}
      {detailModalData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass-card border border-primary/30 w-[800px] h-[600px] rounded-2xl p-6 shadow-2xl flex flex-col">
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-sys-lg font-black text-primary border-l-4 border-primary pl-2">
                {activeTab === 'camera' ? '摄像机' : '服务器'} 详细状态: {detailModalData.id}
              </h2>
              <button onClick={() => setDetailModalData(null)} className="text-on-surface-variant hover:text-error transition-colors">
                <span className="material-symbols-outlined text-3xl">close</span>
              </button>
            </div>
            {/* 留白区：供后续分别设计摄像机/服务器的图表或画面 */}
            <div className="flex-1 border-2 border-dashed border-outline/30 rounded-xl flex flex-col items-center justify-center bg-surface-container-low/50">
              <span className="material-symbols-outlined text-6xl text-outline mb-2">design_services</span>
              <p className="text-on-surface-variant font-bold text-sys-lg">详情面板内容留白区域</p>
              <p className="text-sys-sm text-outline mt-2">后续可在此处嵌入视频流或 CPU/内存 实时折线图</p>
            </div>
          </div>
        </div>
      )}

      <CameraDetailModal 
        cameraId={selectedCameraId} 
        isOpen={!!selectedCameraId} 
        onClose={() => setSelectedCameraId(null)} 
      />

      <ServerDetailModal 
        serverData={selectedServerData} 
        isOpen={!!selectedServerData} 
        onClose={() => setSelectedServerData(null)} 
      />

    </div>
  );
};

export default DeviceInformation;   
