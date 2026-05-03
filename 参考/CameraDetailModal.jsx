import React, { useState, useEffect, useCallback } from 'react';
import { requestWithFallback } from '../api/client';

// --- 组件外提：防止输入时由于 React 重新挂载导致焦点丢失 ---
const InfoRow = ({ label, value, name, isMono = false, highlight = false, error = false, fullWidth = false, editable = false, type = 'text', options = [], isEditing, editFormData, handleInputChange }) => {
  const isEditingThis = isEditing && editable;
  const displayValue = isEditingThis ? (editFormData[name] ?? '') : value;

  return (
    <div className={`flex items-start py-1.5 border-b border-outline/10 last:border-0 ${fullWidth ? 'col-span-2' : ''}`}>
      <span className="text-sys-sm text-on-surface-variant/80 w-32 shrink-0 mt-0.5">{label}</span>

      {isEditingThis ? (
        type === 'select' ? (
          <select name={name} value={displayValue} onChange={handleInputChange} className="bg-surface-container-high border border-outline/30 text-on-surface rounded-md px-2 py-0.5 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm">
            {options.map(opt => {
              // 兼容原始的字符串数组和新的对象数组 { label, value }
              const val = typeof opt === 'object' ? opt.value : opt;
              const label = typeof opt === 'object' ? opt.label : opt;
              return <option key={val} value={val}>{label}</option>;
            })}
          </select>
        ) : (
          <input name={name} value={displayValue} onChange={handleInputChange} autoComplete="off" className="bg-surface-container-high border border-outline/30 text-on-surface rounded-md px-2 py-0.5 w-full focus:outline-none focus:border-primary transition-colors text-sys-sm" />
        )


      ) : (
        <span className={`text-sys-sm break-words ${isMono && !isEditingThis ? 'font-mono' : ''} ${highlight ? 'font-bold text-primary' : ''} ${error ? 'font-bold text-error' : 'text-on-surface'}`}>
          {value}
        </span>
      )}
    </div>
  );
};



const CameraDetailModal = ({ cameraId, isOpen, onClose, serversList = [], onSuccess }) => {
  const normalizeText = (value) => (value === null || value === undefined || value === '' ? '--' : String(value));
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
  
  const buildCameraLocation = (item) => {
    const hasGeo = item.longitude !== null && item.longitude !== undefined && item.latitude !== null && item.latitude !== undefined;
    const geoText = hasGeo ? `${formatLongitude(item.longitude)}, ${formatLatitude(item.latitude)}` : '';
    const descText = item.location_desc ? String(item.location_desc).trim() : '';
    if (geoText && descText) return `${geoText} / ${descText}`;
    return geoText || descText || '--';
  };

  const [cameraData, setCameraData] = useState({
    id: cameraId || '--', name: '--', type: '摄像机', model: '--', status: '在线',
    ip: '--', protocol: 'TCP', codec: '--', streamType: '--',
    location: '--', locationDesc: '--', longitude: '--', latitude: '--',
    unit: '--', manager: '--', serverId: '--', faultDetail: '暂无故障', videoUrl: '',
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [scale, setScale] = useState(1);
  const [chartData, setChartData] = useState(Array.from({ length: 40 }, () => ({ latency: 30, loss: 0 })));

  // --- 新增：编辑状态与方法 ---
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState({});

  const handleEditClick = () => { setEditFormData(cameraData); setIsEditing(true); };
  const handleCancelEdit = () => { setIsEditing(false); setEditFormData({}); };
  const handleInputChange = useCallback((e) => {
    setEditFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }, []);

  const handleSave = async () => {
    try {
      const payload = {
        name: editFormData.name,
        model: editFormData.model !== '--' ? editFormData.model : null,
        ip: editFormData.ip !== '--' ? editFormData.ip : null,
        status: editFormData.status,
        protocol: editFormData.protocol,
        codec: editFormData.codec !== '--' ? editFormData.codec : null,
        stream_type: editFormData.streamType !== '--' ? editFormData.streamType : null,
        unit: editFormData.unit !== '--' ? editFormData.unit : null,
        manager: editFormData.manager !== '--' ? editFormData.manager : null,
        location_desc: editFormData.locationDesc !== '--' ? editFormData.locationDesc : null,
        server_id: editFormData.serverId !== '--' ? editFormData.serverId : null,
      };
      
      await requestWithFallback(`/cameras/${encodeURIComponent(cameraId)}`, {
        method: 'PUT', // 依据后台 API 设定
        body: JSON.stringify(payload)
      });
      
      setCameraData({ ...cameraData, ...editFormData });
      setIsEditing(false);

    // 保存成功后触发父组件刷新，重新加载地图点位和连线
      if (onSuccess) onSuccess(); 
    } catch (error) {
      console.error('Failed to update camera:', error);
      alert(`保存失败：${error.message}`);
    }
  };

  useEffect(() => {
    const handleResize = () => {
      const ratio = Math.min(window.innerWidth / 1320, window.innerHeight / 760);
      setScale(ratio < 1 ? ratio : 1);
    };
    handleResize(); 
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isOpen || !cameraId) return;
    const fetchCameraDetail = async () => {
      try {
        const data = await requestWithFallback(`/cameras/${encodeURIComponent(cameraId)}`);
        setCameraData({
          id: normalizeText(data.id), name: normalizeText(data.name), type: '摄像机', model: normalizeText(data.model), status: data.status || '在线',
          ip: normalizeText(data.ip), protocol: data.protocol || 'TCP', codec: normalizeText(data.codec), streamType: normalizeText(data.stream_type),
          location: buildCameraLocation(data), locationDesc: normalizeText(data.location_desc), longitude: data.longitude ?? null, latitude: data.latitude ?? null,
          unit: normalizeText(data.unit), manager: normalizeText(data.manager), serverId: normalizeText(data.server_id), faultDetail: '暂无故障', videoUrl: data.video_url || '',
        });
      } catch (error) {
        console.error('Failed to fetch camera detail:', error);
      }
    };
    fetchCameraDetail();
  }, [isOpen, cameraId]);

  // 模拟实时网络数据更新 - 如果进入编辑模式 (isEditing)，则暂停图表刷新以防干扰
  useEffect(() => {
    if (!isOpen || isEditing) return; 
    const interval = setInterval(() => {
      setChartData(prev => {
        const last = prev[prev.length - 1];
        const newLatency = Math.max(20, Math.min(60, last.latency + (Math.random() * 10 - 5)));
        const newLoss = Math.random() > 0.85 ? Math.random() * 2 : 0;
        return [...prev.slice(1), { latency: newLatency, loss: newLoss }];
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen, isEditing]);

  if (!isOpen) return null;

  const chartWidth = 400; const chartHeight = 80; const maxLatency = 100; const maxLoss = 5;
  const pointsLatency = chartData.map((d, i) => `${(i / 39) * chartWidth},${chartHeight - (d.latency / maxLatency) * chartHeight}`).join(' ');
  const pointsLoss = chartData.map((d, i) => `${(i / 39) * chartWidth},${chartHeight - (d.loss / maxLoss) * chartHeight}`).join(' ');
  const avgLatency = chartData.reduce((sum, d) => sum + d.latency, 0) / chartData.length;
  const avgLoss = chartData.reduce((sum, d) => sum + d.loss, 0) / chartData.length;
  const currentLatency = avgLatency.toFixed(1);
  const currentLoss = avgLoss.toFixed(2);

  // 根据传入的服务器列表生成下拉框选项
  const serverOptions = [
    { label: '-- 请选择关联的服务器 --', value: '--' }, // 保持与你代码中未选择时传 null / '--' 的逻辑一致
    ...serversList.map(s => ({ 
      label: s.name ? `${s.name} (${s.id})` : s.id, 
      value: s.id 
    }))
  ];


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md" onClick={onClose}>
      <div 
        className="bg-surface/95 border border-primary/20 w-[1200px] h-[680px] rounded-2xl p-6 shadow-2xl flex flex-col origin-center overflow-hidden" 
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `scale(${scale})` }}
      >
        {/* 顶部标题栏 */}
        <div className="flex justify-between items-center mb-5 pb-3 border-b border-outline/10">
          <div className="flex items-center gap-4">
             <div className="bg-primary/10 p-2 rounded-xl">
                 <span className="material-symbols-outlined text-3xl text-primary block">videocam</span>
             </div>
             <div>
                {/* 顶部标题 */}
                <div className="flex items-center gap-3">
                    {isEditing ? (
                        <input name="name" value={editFormData.name || ''} onChange={handleInputChange} className="bg-surface-container-high border border-primary/50 text-on-surface rounded-lg px-2 py-0.5 text-sys-lg font-bold w-48 focus:outline-none" />
                    ) : (
                        <h2 className="text-sys-lg font-bold text-on-surface">{cameraData.name}</h2>
                    )}
                    <span className={`px-2.5 py-0.5 rounded-md text-sys-sm font-bold border ${cameraData.status === '在线' ? 'bg-primary/10 text-primary border-primary/30' : 'bg-error/10 text-error border-error/30'}`}>
                        {cameraData.status}
                    </span>
                </div>
                <p className="text-sys-sm text-on-surface-variant font-mono mt-0.5">ID: {cameraData.id}</p>
             </div>
          </div>
          
          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <button onClick={handleCancelEdit} className="px-4 py-1.5 rounded-lg border border-outline/50 hover:bg-outline/10 text-on-surface font-bold transition-colors text-sys-sm">取消</button>
                <button onClick={handleSave} className="px-4 py-1.5 rounded-lg bg-primary text-background font-bold hover:bg-primary/80 transition-colors text-sys-sm">保存</button>
              </>
            ) : (
              <button onClick={handleEditClick} className="flex items-center gap-1 text-primary hover:bg-primary/10 px-3 py-1.5 rounded-lg transition-all text-sys-sm font-bold border border-primary/30">
                <span className="material-symbols-outlined text-sys-sm">edit</span>编辑
              </button>
            )}
            <button onClick={onClose} className="text-on-surface-variant hover:text-error hover:bg-error/10 p-2 rounded-full transition-all ml-2">
              <span className="material-symbols-outlined text-2xl block">close</span>
            </button>
          </div>
        </div>

        {/* 主体内容：左右双栏布局 */}
        <div className="flex-1 flex gap-8 h-[calc(100%-80px)]">
          {/* 左侧：详细信息卡片流 */}
          <div className="w-[45%] flex flex-col gap-4 overflow-y-auto pr-2 no-scrollbar pb-6">
            
            <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10 shrink-0">
              <h3 className="text-sys-sm font-bold text-on-surface mb-2 flex items-center gap-2">
                <span className="w-1 h-3.5 bg-primary rounded-full block"></span>设备基础信息
              </h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <InfoRow label="设备ID" value={cameraData.id} isMono fullWidth isEditing={isEditing} />
                <InfoRow label="设备类型" value={cameraData.type} fullWidth isEditing={isEditing} />
                <InfoRow label="厂商型号" value={cameraData.model} name="model" editable fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="运行状态" value={cameraData.status} name="status" editable type="select" options={['在线', '故障', '离线']} fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="绑定服务器" value={cameraData.serverId} name="serverId" editable type="select" options={serverOptions} isMono fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
              </div>
            </div>

            <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10 shrink-0">
              <h3 className="text-sys-sm font-bold text-on-surface mb-2 flex items-center gap-2">
                <span className="w-1 h-3.5 bg-primary rounded-full block"></span>网络与编码参数
              </h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <InfoRow label="摄像机 IP" value={cameraData.ip} name="ip" editable isMono fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="传输协议" value={cameraData.protocol} name="protocol" editable type="select" options={['TCP', 'UDP']} isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="编码格式" value={cameraData.codec} name="codec" editable isMono isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="码流类型" value={cameraData.streamType} name="streamType" editable type="select" options={['主码流', '子码流']} fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
              </div>
            </div>

            <div className="bg-surface-container-lowest p-4 rounded-xl border border-outline/10 shrink-0">
              <h3 className="text-sys-sm font-bold text-on-surface mb-2 flex items-center gap-2">
                <span className="w-1 h-3.5 bg-primary rounded-full block"></span>管理与运维信息
              </h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <InfoRow label="归属单位" value={cameraData.unit} name="unit" editable fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="运维人员" value={cameraData.manager} name="manager" editable isMono fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <InfoRow label="经度" value={formatLongitude(cameraData.longitude)} isMono isEditing={isEditing} />
                <InfoRow label="纬度" value={formatLatitude(cameraData.latitude)} isMono isEditing={isEditing} />
                <InfoRow label="位置描述" value={cameraData.locationDesc} name="locationDesc" editable fullWidth isEditing={isEditing} editFormData={editFormData} handleInputChange={handleInputChange} />
                <div className="col-span-2 mt-1 pt-1 border-t border-outline/5">
                  <InfoRow label="故障详情" value={cameraData.faultDetail} error={cameraData.faultDetail !== '暂无故障'} fullWidth isEditing={isEditing} />
                </div>
              </div>
            </div>
          </div>

          {/* 右侧：视频预览与图表分析 */}
          <div className="w-[55%] flex flex-col gap-4">
            <div className="w-full relative aspect-video bg-black rounded-xl overflow-hidden shadow-inner border border-outline/20">
                <video src={cameraData.videoUrl} className="w-full h-full object-cover" controls={false} autoPlay={false} loop={true} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
                <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity group">
                    <button onClick={() => { const videoEl = document.querySelector('video'); isPlaying ? videoEl.pause() : videoEl.play(); }} className="bg-black/60 text-white p-4 rounded-full shadow-lg transform scale-90 group-hover:scale-100 transition-all hover:bg-primary">
                        <span className="material-symbols-outlined text-4xl block">{isPlaying ? 'pause' : 'play_arrow'}</span>
                    </button>
                    <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/50 backdrop-blur-sm px-2.5 py-1.5 rounded-md">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isPlaying ? 'bg-error' : 'bg-primary'}`}></span>
                          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isPlaying ? 'bg-error' : 'bg-primary'}`}></span>
                        </span>
                        <span className="text-sys-sm text-white font-bold uppercase tracking-wider">{isPlaying ? 'LIVE' : 'READY'}</span>
                    </div>
                </div>
            </div>

            <div className="flex-1 bg-surface-container-lowest rounded-xl border border-outline/10 p-4 flex flex-col">
                <div className="flex justify-between items-center mb-3">
                    <h3 className="text-sys-sm font-bold text-on-surface flex items-center gap-2">
                        <span className="material-symbols-outlined text-sys-sm text-primary">monitoring</span>实时网络质量
                    </h3>
                    <div className="flex gap-8 text-sys-sm font-mono">
                        <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.5)]"></span>时延: <span className="font-bold text-on-surface w-20">{currentLatency}ms</span></span>
                        <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.5)]"></span>丢包: <span className="font-bold text-on-surface w-16">{currentLoss}%</span></span>
                    </div>
                </div>
                <div className="flex-1 relative w-full border-b border-l border-outline/20">
                    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full h-full overflow-visible preserve-3d" preserveAspectRatio="none">
                        <line x1="0" y1={chartHeight/2} x2={chartWidth} y2={chartHeight/2} stroke="currentColor" className="text-outline/10" strokeDasharray="4 4" />
                        <polyline points={pointsLatency} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <polyline points={pointsLoss} fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CameraDetailModal;
