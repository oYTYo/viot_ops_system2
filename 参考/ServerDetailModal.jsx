import React, { useState, useEffect } from 'react';
import { requestWithFallback } from '../api/client';

const ServerDetailModal = ({ serverData, isOpen, onClose }) => {
  const normalizeText = (value) => (value === null || value === undefined || value === '' ? '--' : String(value));
  const [serverDetail, setServerDetail] = useState(null);

  const [scale, setScale] = useState(1);
  useEffect(() => {
    const handleResize = () => {
      const widthRatio = window.innerWidth / 1320;
      setScale(widthRatio < 1 ? widthRatio : 1);
    };
    handleResize(); 
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isOpen || !serverData?.id) return;

    const fetchServerDetail = async () => {
      try {
        const data = await requestWithFallback(`/servers/${encodeURIComponent(serverData.id)}`);
        setServerDetail(data);
      } catch (error) {
        console.error('Failed to fetch server detail:', error);
        alert(`加载服务器详情失败：${error.message}`);
      }
    };

    fetchServerDetail();
  }, [isOpen, serverData?.id]);

  if (!isOpen || !serverData) return null;
  const metrics = {
    cpu: Number.isFinite(Number(serverDetail?.cpu_usage)) ? Number(serverDetail.cpu_usage) : 0,
    memory: Number.isFinite(Number(serverDetail?.ram_usage)) ? Number(serverDetail.ram_usage) : 0,
    diskUsage: Number.isFinite(Number(serverDetail?.disk_usage)) ? Number(serverDetail.disk_usage) : 0,
    netBandwidth: Number.isFinite(Number(serverDetail?.net_bandwidth)) ? Number(serverDetail.net_bandwidth) : 0,
    gpuUsage: Number.isFinite(Number(serverDetail?.gpu_usage)) ? Number(serverDetail.gpu_usage) : 0,
  };

  const calculateOffset = (percent, circumference = 251.2) => {
    return circumference - (percent / 100) * circumference;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="glass-card border border-primary/30 w-[1280px] h-[720px] rounded-2xl p-5 shadow-2xl flex flex-col origin-center overflow-hidden" 
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `scale(${scale})` }}
      >
        <div className="flex justify-between items-start mb-6 shrink-0">
          <div className="flex items-center gap-3">
             <span className="material-symbols-outlined text-3xl text-secondary">dns</span>



             <div>
                <h2 className="text-sys-lg font-black text-on-surface">服务器运行状态监控</h2>
                <div className="flex items-center gap-4 mt-1">
                  <p className="text-sys-sm text-secondary/80 font-mono">{normalizeText(serverDetail?.id ?? serverData.id)}</p>
                  <span className={`px-2 py-0.5 rounded text-sys-sm font-black border ${
                          (serverDetail?.status ?? serverData.status) === '正常' ? 'bg-primary/10 text-primary border-primary/30' : 
                          'bg-error/10 text-error border-error/30'
                        }`}>{normalizeText(serverDetail?.status ?? serverData.status)}
                  </span>
                  <p className="text-sys-sm text-on-surface-variant font-mono">IP: {normalizeText(serverDetail?.ip ?? serverData.ip)}</p>
                </div>
             </div>



          </div>
          <button onClick={onClose} className="text-on-surface-variant hover:text-error transition-colors">
            <span className="material-symbols-outlined text-3xl">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-4 no-scrollbar pb-6">
          <div className="grid grid-cols-12 gap-6">
            <aside className="col-span-3 flex flex-col gap-5 justify-start">
              
              <div className="bg-surface-container-low/50 rounded-xl flex flex-col items-center justify-center p-4 border border-outline/10 min-h-[200px]">
                <div className="relative w-44 h-44 flex items-center justify-center shrink-0">
                  <svg className="w-full h-full -rotate-90">
                    <circle cx="50%" cy="50%" r="40%" fill="transparent" stroke="currentColor" strokeWidth="8%" className="text-surface-container-highest"></circle>
                    <circle cx="50%" cy="50%" r="40%" fill="transparent" stroke="currentColor" strokeWidth="8%" 
                      className="text-primary drop-shadow-[0_0_8px_rgba(123,231,249,0.5)] transition-all duration-1000" 
                      strokeDasharray="251.2" strokeDashoffset={calculateOffset(metrics.cpu)}></circle>
                  </svg>
                  <div className="absolute flex flex-col items-center">
                    <span className="text-sys-lg font-bold text-primary">{metrics.cpu}%</span>
                    <span className="text-sys-sm uppercase tracking-widest text-on-surface-variant">CPU占用</span>
                  </div>
                </div>
              </div>

              <div className="bg-surface-container-low/50 rounded-xl flex flex-col items-center justify-center p-4 border border-outline/10 min-h-[200px]">
                <div className="relative w-44 h-44 flex items-center justify-center shrink-0">
                  <svg className="w-full h-full -rotate-90">
                    <circle cx="50%" cy="50%" r="40%" fill="transparent" stroke="currentColor" strokeWidth="8%" className="text-surface-container-highest"></circle>
                    <circle cx="50%" cy="50%" r="40%" fill="transparent" stroke="currentColor" strokeWidth="8%" 
                      className="text-secondary drop-shadow-[0_0_8px_rgba(0,210,252,0.5)] transition-all duration-1000" 
                      strokeDasharray="251.2" strokeDashoffset={calculateOffset(metrics.memory)}></circle>
                  </svg>
                  <div className="absolute flex flex-col items-center">
                    <span className="text-sys-lg font-bold text-secondary">{metrics.memory}%</span>
                    <span className="text-sys-sm uppercase tracking-widest text-on-surface-variant">内存占用</span>
                  </div>
                </div>
              </div>

              <div className="bg-surface-container-low/50 rounded-xl flex flex-col items-center justify-center p-4 border border-outline/10 min-h-[200px]">
                <div className="relative w-44 h-44 flex items-center justify-center shrink-0">
                  <svg className="w-full h-full -rotate-90">
                    <circle cx="50%" cy="50%" r="40%" fill="transparent" stroke="currentColor" strokeWidth="8%" className="text-surface-container-highest"></circle>
                    <circle cx="50%" cy="50%" r="40%" fill="transparent" stroke="currentColor" strokeWidth="8%" 
                      className="text-error drop-shadow-[0_0_8px_rgba(255,113,108,0.5)] transition-all duration-1000" 
                      strokeDasharray="251.2" strokeDashoffset={calculateOffset(metrics.diskUsage)}></circle>
                  </svg>
                  <div className="absolute flex flex-col items-center">
                    <span className="text-sys-lg font-bold text-error">{metrics.diskUsage}%</span>
                    <span className="text-sys-sm uppercase tracking-widest text-on-surface-variant">磁盘占用</span>
                  </div>
                </div>
              </div>
            </aside>



<section className="col-span-9 flex flex-col gap-6">
              
              {/* 顶部: 网络吞吐量与带宽 (趋势折线图化) */}
              <div className="bg-surface-container-low/40 rounded-xl p-6 border border-outline/10 flex flex-col justify-between relative overflow-hidden h-[180px] shrink-0">
                <div className="flex justify-between items-start">

                  <div>
                    <h3 className="text-sys-sm font-bold text-on-surface tracking-tight">网络 I/O 与带宽占用</h3>
                    <div className="flex gap-6 mt-2 text-sys-sm text-on-surface-variant font-mono">
                      <span>↑ 发送: <span className="text-secondary font-bold text-sys-sm">1.2 Gbps</span></span>
                      <span>↓ 接收: <span className="text-primary font-bold text-sys-sm">850 Mbps</span></span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-3xl font-black text-primary font-mono">{metrics.netBandwidth}<span className="text-sys-sm font-light">%</span></div>
                    <div className="text-sys-sm text-on-surface-variant uppercase">网卡带宽占用率</div>
                  </div>


                </div>
                {/* 模拟折线 */}
                <div className="absolute bottom-0 left-0 w-full h-[80px] opacity-70">
                   <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 400 100">
                      <path d="M0,80 L40,60 L80,90 L120,40 L160,50 L200,20 L240,60 L280,10 L320,70 L360,30 L400,50" fill="none" stroke="#7be7f9" strokeWidth="2.5"></path>
                      <path d="M0,90 L50,70 L100,80 L150,50 L200,60 L250,30 L300,50 L350,20 L400,60" fill="none" stroke="#00d2fc" strokeWidth="2"></path>
                   </svg>
                </div>
              </div>



              {/* 中部: CPU / 内存 / GPU (进度条可视化) */}
              <div className="grid grid-cols-3 gap-6 min-h-[160px] shrink-0">
                {/* CPU分配 */}
                <div className="bg-surface-container-low/40 rounded-xl p-5 border border-outline/10 flex flex-col justify-between">
                  <div className="flex justify-between items-start">
                    <span className="text-sys-sm font-medium text-on-surface-variant">CPU核数 / 分配</span>
                    <span className="text-sys-sm bg-primary/20 text-primary px-2 py-0.5 rounded">Intel Xeon Gold 6248</span>
                  </div>
                  <div className="mt-2">
                    <h3 className="text-sys-lg font-bold font-mono text-on-surface">24 <span className="text-sys-sm text-on-surface-variant font-normal">/ 48 Core</span></h3>
                    <div className="w-full h-1.5 bg-surface-container-highest rounded-full mt-2 overflow-hidden flex">
                      <div className="h-full bg-primary w-[50%]"></div>
                    </div>
                  </div>
                </div>

                {/* 内存分配 */}
                <div className="bg-surface-container-low/40 rounded-xl p-5 border border-outline/10 flex flex-col justify-between">
                   <div className="flex justify-between items-start">
                    <span className="text-sys-sm font-medium text-on-surface-variant">内存占用 / 可分配</span>
                    <span className="material-symbols-outlined text-secondary text-sys-lg">memory</span>
                  </div>
                  <div className="mt-2">
                    <h3 className="text-sys-lg font-bold font-mono text-on-surface">180 <span className="text-sys-sm text-on-surface-variant font-normal">/ 256 GB</span></h3>
                    <div className="w-full h-1.5 bg-surface-container-highest rounded-full mt-2 overflow-hidden flex">
                      <div className="h-full bg-secondary w-[70%] drop-shadow-[0_0_5px_rgba(0,210,252,0.5)]"></div>
                    </div>
                  </div>
                </div>

                {/* GPU状态 */}
                <div className="bg-surface-container-low/40 rounded-xl p-5 border border-outline/10 flex flex-col justify-between">
                   <div className="flex justify-between items-start">
                    <span className="text-sys-sm font-medium text-on-surface-variant">GPU 利用率 / 显存</span>
                    <span className="text-sys-sm bg-error/20 text-error px-2 py-0.5 rounded">Tesla T4</span>
                  </div>
                  <div className="mt-2 flex justify-between items-end">
                    <h3 className="text-sys-lg font-bold font-mono text-error">{metrics.gpuUsage}%</h3>
                    <span className="text-sys-sm text-on-surface-variant font-mono">12GB / 16GB</span>
                  </div>
                   <div className="w-full h-1.5 bg-surface-container-highest rounded-full mt-2 overflow-hidden flex">
                      <div className="h-full bg-error w-[75%] drop-shadow-[0_0_5px_rgba(255,113,108,0.5)]"></div>
                   </div>
                </div>
              </div>




              {/* 底部: 磁盘 IO (复用原本优良的柱状图设计) */}
              <div className="bg-surface-container-low/40 rounded-xl p-5 border border-outline/10 flex flex-col justify-between flex-1 min-h-[160px] mt-2">

                <div className="flex justify-between items-center mb-2">
                  <h4 className="text-sys-sm font-bold text-on-surface">磁盘 I/O 吞吐量</h4>
                  <div className="flex gap-4 tracking-tight">
                    <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-primary"></div><span className="text-sys-sm text-on-surface-variant">读: 450 MB/s</span></div>
                    <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-secondary"></div><span className="text-sys-sm text-on-surface-variant">写: 120 MB/s</span></div>
                  </div>
                </div>


                <div className="flex-1 flex items-end gap-[2px] opacity-80 pt-1 pb-1">
                  {[60,40,80,50,95,30,20,45,55,65,100,35,90,55,100,60,80,95,30,100,60,40,80,50,95,30,20,45].map((h, i) => (
                    <div key={i} className={`flex-1 rounded-t-sm transition-all hover:bg-opacity-100 ${i % 3 === 0 ? 'bg-secondary' : 'bg-primary/50'}`} style={{ height: `${h}%` }}></div>
                  ))}
                </div>
              </div>

            </section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServerDetailModal;
