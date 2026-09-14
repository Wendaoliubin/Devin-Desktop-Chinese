/**
 * Windsurf Better v1.5.7
 * 整合版：气泡提示 + 汉化 + 自动继续
 * v1.4.4: 修复AI提问不提示、长时间运行不自动继续、配额余额检查
 * v1.4.5: 修复AI正常完成后空闲监控仍触发自动继续
 * v1.4.6: 彻底修复AI正常完成后空闲仍触发(增加完成确认标志+扩展正常结尾检测)
 * v1.4.7: 增强配额检测(更多关键词+选择器+诊断)，修复新版Windsurf配额耗尽检测不到
 * v1.4.8: 修复isQuotaTrulyExhausted()永远返回true、修复wsDiag()循环引用崩溃、修复误触继续
 * v1.5.7: 配额耗尽绕过aiCompletedNormally和square图标检查、
 *         用户手动输入"继续"不触发自动继续、跨窗口锁15s+及时释放
 */
(function () {
	'use strict';
	const VERSION = '1.5.7';
	const LOG_PREFIX = '[WS-Better]';

	// ========== Trusted Types 支持 ==========
	// Windsurf要求TrustedHTML，必须通过policy创建
	let _ttPolicy = null;
	function getTTPolicy() {
		if (_ttPolicy) return _ttPolicy;
		try {
			if (window.trustedTypes && window.trustedTypes.createPolicy) {
				_ttPolicy = window.trustedTypes.createPolicy('abBubbles', {
					createHTML: (input) => input,
					createScript: (input) => input,
					createScriptURL: (input) => input,
				});
			}
		} catch (e) { console.log(LOG_PREFIX + 'TrustedTypes policy创建失败:', e.message); }
		return _ttPolicy;
	}
	function setTrustedHTML(el, html) {
		const policy = getTTPolicy();
		if (policy) { el.innerHTML = policy.createHTML(html); }
		else { el.innerHTML = html; }
	}
	
	// ========== 统一配置 ==========
	const DEFAULT_SETTINGS = {
		// 气泡设置
		bubblesEnabled: true,
		bubblesAutoSend: true,
		bubblesTheme: 'emerald',
		bubblesShape: 'rounded',
		// 汉化设置
		localizationEnabled: true,
		// 自动继续
		autoContinueEnabled: true,
		// 多轮对话队列
		chatQueueEnabled: true,
		// 通知与提示音
		notifySoundEnabled: true,
		notifySoundVolume: 0.3,
		notifySoundPreset: 'chime',
		notifySystemEnabled: true,
		// 各事件通知开关
		notifyOnComplete: true,      // AI回复完成
		notifyOnAutoContinue: true,  // 自动发送了"继续"
		notifyOnQuotaExhaust: false, // 配额耗尽（默认关闭）
		notifyOnQueueDone: true,     // 队列全部完成
		notifyOnAiQuestion: true,    // AI提问需要用户输入
		togglePos: null,
		// 外观
		panelBgColor: '#1e1e2e',
		toggleBgColor: 'rgba(128,128,128,.15)',
	};
	const STORAGE_KEY = 'ws-better-settings';
	
	function loadSettings() {
		try {
			const r = localStorage.getItem(STORAGE_KEY);
			return r ? { ...DEFAULT_SETTINGS, ...JSON.parse(r) } : { ...DEFAULT_SETTINGS };
		} catch {
			return { ...DEFAULT_SETTINGS };
		}
	}
	
	function saveSettings(s) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
		} catch {}
	}
	
	let settings = loadSettings();

	// 监听localStorage变化，实时更新设置（webview侧边栏修改后触发）
	window.addEventListener('storage', (e) => {
		if (e.key === STORAGE_KEY) {
			settings = loadSettings();
			console.log(LOG_PREFIX + '[Settings] 设置已更新:', JSON.stringify(settings));
		}
	});
	// 全局函数：供Extension注入调用
	window.__wsBetterReloadSettings = () => {
		settings = loadSettings();
		console.log(LOG_PREFIX + '[Settings] Extension触发设置更新');
	};
	// 轮询Extension写入的临时文件（webview localStorage与workbench隔离，需通过文件中转）
	// Extension webview修改设置后，Extension host写入 %TEMP%/ws-better-settings-update.json
	const _settingsUpdatePath = (() => {
		try {
			// Electron环境中可以用process.env.TEMP
			if (typeof process !== 'undefined' && process.env && process.env.TEMP) {
				return require('path').join(process.env.TEMP, 'ws-better-settings-update.json');
			}
		} catch {}
		return null;
	})();
	if (_settingsUpdatePath) {
		let _lastSettingsUpdateTs = 0;
		setInterval(() => {
			try {
				const fs = require('fs');
				const content = fs.readFileSync(_settingsUpdatePath, 'utf-8');
				const update = JSON.parse(content);
				if (update.ts > _lastSettingsUpdateTs) {
					_lastSettingsUpdateTs = update.ts;
					// 应用设置变更到localStorage
					const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
					s[update.key] = update.value;
					localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
					settings = loadSettings();
					console.log(LOG_PREFIX + '[Settings] 从Extension文件更新设置: ' + update.key + '=' + JSON.stringify(update.value));
				}
			} catch {}
		}, 2000);
	}
	
	// ========== 气泡功能 ==========
	const CHAT_ROOT_SELECTOR = '.chat-client-root';
	const INPUT_CANDIDATES = [
		'div[contenteditable="true"][data-lexical-editor="true"]',
		'div[contenteditable="true"][role="textbox"]',
		'div[contenteditable="true"]',
		'textarea',
	];
	const SEND_BTN_CANDIDATES = [
		// 真实确认: submit按钮内含svg.lucide-arrow-up
		'button[type="submit"]',
		// 以下为猜测兜底
		'button[data-tooltip-id*="send"]',
		'button[aria-label*="Send"]',
		'button[aria-label*="send"]',
		'button.send-button',
	];
	
	const BUBBLE_THEMES = [
		{ id:'emerald',name:'翡翠',bg:'linear-gradient(135deg,#22c55e,#06b6d4,#3b82f6)',bgHover:'linear-gradient(135deg,#16a34a,#0891b2,#2563eb)',color:'#fff',shadow:'0 2px 8px rgba(34,197,94,.2)',border:'none',letterBg:'rgba(255,255,255,.2)',letterColor:'#fff',tagBg:'linear-gradient(135deg,#22c55e,#06b6d4,#3b82f6)'},
		{ id:'aurora',name:'极光',bg:'linear-gradient(135deg,#a855f7,#ec4899)',bgHover:'linear-gradient(135deg,#9333ea,#db2777)',color:'#fff',shadow:'0 2px 8px rgba(168,85,247,.2)',border:'none',letterBg:'rgba(255,255,255,.2)',letterColor:'#fff',tagBg:'linear-gradient(135deg,#a855f7,#ec4899)'},
		{ id:'sunset',name:'日落',bg:'linear-gradient(135deg,#f59e0b,#ef4444)',bgHover:'linear-gradient(135deg,#d97706,#dc2626)',color:'#fff',shadow:'0 2px 8px rgba(245,158,11,.2)',border:'none',letterBg:'rgba(255,255,255,.2)',letterColor:'#fff',tagBg:'linear-gradient(135deg,#f59e0b,#ef4444)'},
		{ id:'ocean',name:'海洋',bg:'#1e40af',bgHover:'#1e3a8a',color:'#fff',shadow:'0 2px 8px rgba(30,64,175,.25)',border:'none',letterBg:'rgba(255,255,255,.15)',letterColor:'#fff',tagBg:'#1e40af'},
		{ id:'glass',name:'毛玻璃',bg:'rgba(255,255,255,.08)',bgHover:'rgba(255,255,255,.14)',color:'rgba(255,255,255,.8)',shadow:'0 2px 8px rgba(0,0,0,.1)',border:'1px solid rgba(255,255,255,.12)',letterBg:'rgba(255,255,255,.1)',letterColor:'rgba(255,255,255,.6)',tagBg:'rgba(167,139,250,.3)',blur:true},
		{ id:'dark',name:'暗夜',bg:'#1f2937',bgHover:'#111827',color:'#e5e7eb',shadow:'0 2px 8px rgba(0,0,0,.3)',border:'1px solid rgba(255,255,255,.08)',letterBg:'rgba(255,255,255,.1)',letterColor:'#9ca3af',tagBg:'#374151'},
	];
	const BUBBLE_SHAPES = [{id:'pill',radius:'20px'},{id:'rounded',radius:'10px'},{id:'soft',radius:'6px'},{id:'sharp',radius:'2px'}];
	const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	const ICON_BUBBLES = 'M20,2H4C2.9,2,2,2.9,2,4v18l4-4h14c1.1,0,2-0.9,2-2V4C22,2.9,21.1,2,20,2z M6,14v-2h8v2H6z M14,11H6V9h8V11z M18,8H6V6h12V8z';
	
	function injectBubblesStyles() {
		if (document.getElementById('ws-bubbles-css')) return;
		const style = document.createElement('style');
		style.id = 'ws-bubbles-css';
		style.textContent = `
.ws-bubbles{margin:16px 0 12px;padding:0;background:none;border:none;border-radius:0;animation:wsBubbleFadeIn .35s ease}
@keyframes wsBubbleFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.ws-bubbles-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.ws-bubbles-title{font-size:13px;font-weight:600;color:#0ea5e9!important;display:flex;align-items:center;gap:6px}
.ws-bubbles-title svg{width:14px;height:14px;fill:#0ea5e9}
.ws-bubbles-question{font-size:13px;color:#0ea5e9!important;font-weight:500;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
.ws-bubbles-mode-tag{font-size:10px;color:#fff;background:linear-gradient(135deg,#22c55e,#06b6d4,#3b82f6);padding:2px 8px;border-radius:10px;margin-left:8px}
.ws-bubble-option{display:flex!important;align-items:center!important;gap:12px!important;padding:10px 14px!important;margin-bottom:6px!important;border-radius:10px!important;cursor:pointer!important;transition:all .2s ease!important;background:linear-gradient(135deg,#22c55e,#06b6d4,#3b82f6)!important;border:none!important;box-shadow:0 2px 8px rgba(34,197,94,.2)}
.ws-bubble-option:hover{background:linear-gradient(135deg,#16a34a,#0891b2,#2563eb)!important;box-shadow:0 4px 12px rgba(34,197,94,.3);transform:translateX(3px)}
.ws-bubble-option-letter{width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.2);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
.ws-bubble-option-text{font-size:13px!important;color:#fff!important;font-weight:500!important;flex:1}
.ws-bubbles-chips{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.ws-bubble-chip{display:inline-flex!important;align-items:center!important;gap:6px!important;padding:8px 16px!important;border-radius:10px!important;cursor:pointer!important;font-size:13px!important;font-weight:500!important;font-family:inherit!important;color:#fff!important;background:linear-gradient(135deg,#22c55e,#06b6d4,#3b82f6)!important;border:none!important;transition:all .2s ease!important;box-shadow:0 2px 8px rgba(34,197,94,.2)}
.ws-bubble-chip::before{content:'\\2726';font-size:8px;color:rgba(255,255,255,.8);flex-shrink:0}
.ws-bubble-chip:hover{background:linear-gradient(135deg,#16a34a,#0891b2,#2563eb)!important;color:#fff!important;transform:translateY(-1px);box-shadow:0 4px 12px rgba(34,197,94,.3)}
.ws-bubble-related{display:flex!important;align-items:center!important;padding:11px 14px!important;margin-bottom:6px!important;border-radius:10px!important;cursor:pointer!important;font-size:13px!important;font-weight:500!important;font-family:inherit!important;color:#fff!important;background:linear-gradient(135deg,#ca8a04,#22c55e,#06b6d4,#3b82f6)!important;border:none!important;transition:all .2s ease!important;text-align:left!important;width:100%!important;box-shadow:0 2px 8px rgba(34,197,94,.2)}
.ws-bubble-related::before{content:'\\2192';margin-right:10px;color:rgba(255,255,255,.8);font-weight:700;font-size:14px}
.ws-bubble-related:hover{background:linear-gradient(135deg,#ca8a04,#16a34a,#0891b2,#2563eb)!important;box-shadow:0 4px 12px rgba(34,197,94,.3);transform:translateX(3px)}
.ws-bubble-custom-input{flex:1;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#e5e7eb;font-size:13px;outline:none}
.ws-bubble-custom-input:focus{border-color:rgba(59,130,246,.5)}
.ws-bubble-custom-send{padding:5px 12px;border-radius:6px;border:none;background:linear-gradient(135deg,#7c3aed,#667eea);color:#fff;font-size:12px;cursor:pointer;font-family:inherit}
.ws-bubble-custom-send:hover{filter:brightness(1.15)}
`;
		document.head.appendChild(style);
	}
	
	function logBubbles(...args) { console.log(LOG_PREFIX + '[Bubbles]', ...args); }

	// ========== 统一配额耗尽检测 ==========
	// Windsurf v1.6+ 配额耗尽显示为顶部banner浮层（不在[data-step-index]中）
	// banner DOM: div.z-\[1000\].absolute.rounded.px-2.bg-red-600 / bg-yellow-600
	//   → p "Your included daily usage quota is exhausted..."
	const EXHAUST_KEYWORDS = [
		'your included usage quota is exhausted',
		'your included daily usage quota is exhausted',
		'your included weekly usage quota is exhausted',
		'quota is exhausted',
		'usage quota is exhausted',
		'配额已用完',
		'每日配额已用完',
		'weekly usage quota',
		'daily usage quota',
		'quota exhausted',
		'upgrade to continue',
		'purchase additional',
		// v1.7+ 新增关键词
		'your included usage',
		'usage limit reached',
		'limit reached',
		'out of credits',
		'no credits remaining',
		'credits exhausted',
		'insufficient credits',
		'run out of',
		'free tier limit',
		'free usage limit',
		'monthly limit reached',
		'cycle limit',
		'billing cycle',
		'rate limit exceeded',
		'too many requests',
		'capacity exceeded',
		'余额不足',
		'额度已用完',
		'额度耗尽',
		'使用额度',
		'已超出限制',
		'达到上限',
		'次数已用完',
		'请求过多',
		'频率限制',
	];
	// 激进文本清理：去除所有不可见字符后toLowerCase+合并空白
	function cleanText(raw) {
		return raw
			.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u2061-\u2064\u206A-\u206F]/g, '') // 零宽字符
			.replace(/[^\S\n]+/g, ' ')  // 非换行空白合并为一个空格
			.replace(/\n+/g, ' ')       // 换行变空格
			.toLowerCase()
			.trim();
	}
	/**
	 * 检测配额耗尽：同时搜索banner浮层和step元素
	 * @returns {{ detected: boolean, source: 'banner'|'step'|'none', element: Element|null, text: string }}
	 */
	function detectQuotaExhausted() {
		// 重要：必须用document搜索，不能用chatRoot！
		// 因为[data-step-index]和banner可能在chat-client-root之外
		// 1. 检测banner浮层（Windsurf新版本的主要方式）
		const bannerSelectors = [
			'div[class*="z-"][class*="absolute"][class*="rounded"]',
			'div[class*="z-"][class*="absolute"][class*="bg-red"]',
			'div[class*="z-"][class*="absolute"][class*="bg-yellow"]',
			'div.absolute.rounded[class*="px-2"]',
			'div[class*="bg-red-600"]',
			'div[class*="bg-yellow-600"]',
			'div[class*="bg-red-500"]',
			'div[class*="bg-yellow-500"]',
			'[class*="ige"]',
			// v1.7+ 新增选择器
			'div[class*="z-"][class*="fixed"]',
			'div[class*="fixed"][class*="top"]',
			'div[class*="notification"]',
			'div[class*="toast"]',
			'div[class*="alert"]',
			'div[class*="banner"]',
			'div[class*="warning"]',
			'div[class*="error-bar"]',
			'div[class*="status-bar"][class*="error"]',
			'[role="alert"]',
			'[role="status"]',
			'div[class*="bg-error"]',
			'div[class*="bg-warning"]',
			'div[class*="text-red-5"]',
			'div[class*="text-yellow-5"]',
			// v1.8+ 新增选择器（Windsurf持续改版）
			'div[class*="inline-flex"][class*="rounded"]',
			'div[class*="overlay"]',
			'div[class*="popup"]',
			'div[class*="snackbar"]',
			'div[class*="callout"]',
			'div[class*="notice"]',
			'div[class*="message-bar"]',
			'div[class*="info-bar"]',
			'div[class*="bg-destructive"]',
			'div[class*="text-destructive"]',
			'div[class*="border-red"]',
			'div[class*="border-yellow"]',
			'div[class*="animate-in"]',
			'div[class*="fade-in"]',
			'div[class*="slide-in"]',
		];
		const checked = new Set();
		// 搜索范围：document + 所有iframe的contentDocument + shadow DOM
		const searchRoots = [document];
		try {
			for (const f of document.querySelectorAll('iframe')) {
				try { if (f.contentDocument) searchRoots.push(f.contentDocument); } catch {}
			}
		} catch {}
		// 穿透shadow DOM的查询函数
		function queryAll(root, selector) {
			const results = Array.from(root.querySelectorAll(selector));
			try {
				for (const el of root.querySelectorAll('*')) {
					if (el.shadowRoot) {
						results.push(...queryAll(el.shadowRoot, selector));
					}
				}
			} catch {}
			return results;
		}
		for (const root of searchRoots) {
			for (const sel of bannerSelectors) {
				for (const banner of queryAll(root, sel)) {
					if (checked.has(banner)) continue;
					checked.add(banner);
					const txt = cleanText(banner.textContent || '');
					if (EXHAUST_KEYWORDS.some(kw => txt.includes(kw))) {
						console.log(LOG_PREFIX + '[QuotaDetect] 🎯检测到配额耗尽banner: "' + txt.substring(0, 80) + '..."');
						return { detected: true, source: 'banner', element: banner, text: txt };
					}
				}
			}
			// 1.5 全局兜底：搜索所有可见的绝对定位元素中的配额文本
			for (const el of queryAll(root, 'div.absolute, div[class*="z-10"], div[class*="z-20"], div[class*="z-30"], div[class*="z-40"], div[class*="z-50"], div[class*="z-["], [class*="ige"]')) {
				if (checked.has(el)) continue;
				try {
					const rect = el.getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) continue;
				} catch { continue; }
				const txt = cleanText(el.textContent || '');
				if (EXHAUST_KEYWORDS.some(kw => txt.includes(kw))) {
					console.log(LOG_PREFIX + '[QuotaDetect] 🎯兜底检测到配额耗尽元素: "' + txt.substring(0, 80) + '..."');
					return { detected: true, source: 'banner', element: el, text: txt };
				}
			}
			// 1.7 终极兜底：搜索document中所有可见div的textContent（不限选择器）
			// 这是最后防线，防止Windsurf改版后banner选择器全部失效
			try {
				const allDivs = root.querySelectorAll('div, p, span');
				for (const el of allDivs) {
					if (checked.has(el)) continue;
					// 只检查短文本元素（banner文本通常<500字），跳过巨型容器
					const rawTxt = (el.textContent || '').trim();
					if (rawTxt.length > 500 || rawTxt.length < 10) continue;
					// 必须是可见元素
					try {
						const rect = el.getBoundingClientRect();
						if (rect.width === 0 || rect.height === 0) continue;
					} catch { continue; }
					// 子元素不能也匹配（避免重复匹配父容器）
					let childAlsoMatches = false;
					for (const child of el.children) {
						const childTxt = cleanText(child.textContent || '');
						if (EXHAUST_KEYWORDS.some(kw => childTxt.includes(kw))) { childAlsoMatches = true; break; }
					}
					if (childAlsoMatches) continue; // 让子元素去匹配
					const txt = cleanText(rawTxt);
					if (EXHAUST_KEYWORDS.some(kw => txt.includes(kw))) {
						console.log(LOG_PREFIX + '[QuotaDetect] 🎯终极兜底检测到配额耗尽: "' + txt.substring(0, 80) + '..." (tag=' + el.tagName + ', class=' + (el.className || '').substring(0, 60) + ')');
						return { detected: true, source: 'banner', element: el, text: txt };
					}
				}
			} catch {}
			// 1.6 搜索bg-red-600/yellow-600的step内联配额消息
			for (const el of queryAll(root, '[data-step-index] div[class*="bg-red-6"], [data-step-index] div[class*="bg-yellow-6"]')) {
				if (checked.has(el)) continue;
				checked.add(el);
				const txt = cleanText(el.textContent || '');
				if (EXHAUST_KEYWORDS.some(kw => txt.includes(kw))) {
					console.log(LOG_PREFIX + '[QuotaDetect] 🎯检测到step内联配额耗尽: "' + txt.substring(0, 80) + '..."');
					return { detected: true, source: 'step', element: el, text: txt };
				}
			}
			// 2. 检测所有step元素中的配额耗尽文本（检查最近N个step）
			const allSteps = queryAll(root, '[data-step-index]');
			if (allSteps.length > 0) {
				const stepArr = allSteps.map(s => ({
					el: s,
					idx: parseInt(s.getAttribute('data-step-index') || '0')
				})).sort((a, b) => b.idx - a.idx);
				const checkCount = Math.min(5, stepArr.length);
				for (let i = 0; i < checkCount; i++) {
					const s = stepArr[i];
					const txt = cleanText(s.el.textContent || '');
					if (EXHAUST_KEYWORDS.some(kw => txt.includes(kw))) {
						console.log(LOG_PREFIX + '[QuotaDetect] 🎯检测到step中配额耗尽(step=' + s.idx + '): "' + txt.substring(0, 80) + '..."');
						return { detected: true, source: 'step', element: s.el, text: txt };
					}
				}
				// 调试：输出最后一个step的清理后文本
				if (stepArr.length > 0) {
					const lastTxt = cleanText(stepArr[0].el.textContent || '');
					console.log(LOG_PREFIX + '[QuotaDetect] 🔍最后step(' + stepArr[0].idx + ')清理后文本前120字="' + lastTxt.substring(0, 120) + '"');
				}
			}
		}
		// 诊断：输出检测失败时的关键信息
		console.log(LOG_PREFIX + '[QuotaDetect] ❌未检测到配额耗尽 | checked=' + checked.size + '个元素');
		// 输出最后step的文本尾部（帮助判断AI是否正常完成）
		const diagSteps = document.querySelectorAll('[data-step-index]');
		if (diagSteps.length > 0) {
			let lastDiag = null, lastDiagIdx = -1;
			for (const s of diagSteps) {
				const idx = parseInt(s.getAttribute('data-step-index') || '0');
				if (idx > lastDiagIdx) { lastDiagIdx = idx; lastDiag = s; }
			}
			if (lastDiag) {
				const diagTxt = cleanText(lastDiag.textContent || '');
				console.log(LOG_PREFIX + '[QuotaDetect] 🔍最后step(' + lastDiagIdx + ')末尾60字="' + diagTxt.slice(-60) + '"');
			}
		}
		// 诊断增强：搜索所有可见短文本元素中含quota/limit/credits的，帮助定位新版banner
		try {
			const diagEls = document.querySelectorAll('div, p, span');
			let diagCount = 0;
			for (const el of diagEls) {
				if (diagCount >= 5) break;
				const raw = (el.textContent || '').trim();
				if (raw.length > 500 || raw.length < 10) continue;
				try {
					const rect = el.getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) continue;
				} catch { continue; }
				const lower = raw.toLowerCase();
				if (lower.includes('quota') || lower.includes('exhaust') || lower.includes('limit reached') || lower.includes('credits') || lower.includes('耗尽') || lower.includes('用完') || lower.includes('额度')) {
					if (!checked.has(el)) {
						console.log(LOG_PREFIX + '[QuotaDetect] ⚠️漏检元素: tag=' + el.tagName + ' class="' + (el.className || '').toString().substring(0, 80) + '" text="' + raw.substring(0, 100) + '"');
						diagCount++;
					}
				}
			}
		} catch {}
		return { detected: false, source: 'none', element: null, text: '' };
	}

	// 全局版本号（方便控制台检查）
	window.__wsBetterVersion = VERSION;

	// 全局alert诊断（不依赖console.log，因为有些环境过滤日志）
	window.wsDiagAlert = function() {
		try {
			var result = detectQuotaExhausted();
			var msg = 'v' + VERSION + '\n检测: ' + result.detected + '\n来源: ' + result.source + '\n文本: ' + (result.text || '').substring(0, 100);
			if (result.element) {
				msg += '\n元素tag: ' + result.element.tagName + '\n元素class: ' + (result.element.className || '').toString().substring(0, 80);
			}
			// 搜索可见配额关键词元素
			var found = [];
			var allEls = document.querySelectorAll('div, p, span');
			for (var i = 0; i < allEls.length && found.length < 5; i++) {
				var el = allEls[i];
				var raw = (el.textContent || '').trim();
				if (raw.length > 300 || raw.length < 5) continue;
				try { var r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; } catch { continue; }
				var lower = raw.toLowerCase();
				if (lower.includes('quota') || lower.includes('exhaust') || lower.includes('耗尽') || lower.includes('用完') || lower.includes('余额') || lower.includes('额度') || lower.includes('limit reached') || lower.includes('credits')) {
					found.push(el.tagName + '.' + (el.className || '').toString().substring(0, 40) + ': ' + raw.substring(0, 60));
				}
			}
			if (found.length > 0) {
				msg += '\n\n配额关键词元素(' + found.length + '):\n' + found.join('\n');
			} else {
				msg += '\n\n未找到配额关键词元素';
			}
			alert(msg);
		} catch(e) {
			alert('wsDiagAlert出错: ' + (e.message || e));
		}
	};

	// 全局诊断函数：用户可在控制台调用 wsDiag() 查看配额检测状态
	window.wsDiag = function() {
		try {
			console.log('=== WS-Better v' + VERSION + ' 配额检测诊断 ===');
			var result;
			try {
				result = detectQuotaExhausted();
			} catch(e) {
				console.error('detectQuotaExhausted()出错:', e.message || e);
				result = { detected: false, source: 'error', element: null, text: '' };
			}
			// 安全序列化：排除element（DOM元素含React fiber循环引用会导致JSON.stringify崩溃）
			const safeResult = { detected: result.detected, source: result.source, text: result.text, elementTag: result.element?.tagName, elementClass: (result.element?.className || '').toString().substring(0, 80) };
			console.log('detectQuotaExhausted():', JSON.stringify(safeResult));
		// 搜索所有含quota/exhausted/limit等文本的可见元素
		const candidates = [];
		const allEls = document.querySelectorAll('div, p, span');
		for (const el of allEls) {
			const raw = (el.textContent || '').trim();
			if (raw.length > 500 || raw.length < 5) continue;
			try {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
			} catch { continue; }
			const lower = raw.toLowerCase();
			if (lower.includes('quota') || lower.includes('exhaust') || lower.includes('耗尽') || lower.includes('用完') || lower.includes('余额') || lower.includes('额度') || lower.includes('limit') || lower.includes('credits') || lower.includes('tier') || lower.includes('billing') || lower.includes('rate') || lower.includes('capacity') || lower.includes('达到上限') || lower.includes('不足') || lower.includes('超出')) {
				candidates.push({
					tag: el.tagName,
					class: (el.className || '').toString().substring(0, 80),
					text: raw.substring(0, 120),
					rect: el.getBoundingClientRect().toJSON()
				});
			}
		}
		console.log('含quota/limit/余额关键词的可见元素(' + candidates.length + '个):', candidates);
		// 检查所有[role=alert]和[role=status]元素
		const alerts = document.querySelectorAll('[role="alert"], [role="status"]');
		const alertInfo = [];
		for (const a of alerts) {
			const raw = (a.textContent || '').trim();
			if (raw.length > 0) alertInfo.push({ tag: a.tagName, class: (a.className||'').toString().substring(0,80), text: raw.substring(0,120) });
		}
		console.log('[role=alert/status]元素(' + alertInfo.length + '个):', alertInfo);
		// 检查所有绝对/固定定位的可见短文本元素（可能是banner）
		const floatingEls = [];
		for (const el of document.querySelectorAll('div[class*="absolute"], div[class*="fixed"], div[class*="z-10"], div[class*="z-20"], div[class*="z-30"], div[class*="z-40"], div[class*="z-50"]')) {
			const raw = (el.textContent || '').trim();
			if (raw.length > 300 || raw.length < 3) continue;
			try {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
			} catch { continue; }
			floatingEls.push({ tag: el.tagName, class: (el.className||'').toString().substring(0,80), text: raw.substring(0,120) });
		}
		console.log('浮动/高z-index短文本元素(' + floatingEls.length + '个):', floatingEls.slice(0, 20));
		// 检查所有[data-step-index]
		const steps = document.querySelectorAll('[data-step-index]');
		console.log('data-step-index元素数量:', steps.length);
		if (steps.length > 0) {
			const sorted = Array.from(steps).map(s => ({
				el: s, idx: parseInt(s.getAttribute('data-step-index') || '0')
			})).sort((a, b) => b.idx - a.idx);
			for (let i = 0; i < Math.min(3, sorted.length); i++) {
				console.log('step(' + sorted[i].idx + '):', cleanText(sorted[i].el.textContent || '').substring(0, 200));
			}
		}
		console.log('=== 诊断结束 ===');
		} catch(e) {
			console.error('wsDiag()出错:', e.message || e, e.stack);
		}
	};

	function findChatRoot() {
		let root = document.querySelector(CHAT_ROOT_SELECTOR);
		if (root) return root;
		try {
			for (const f of document.querySelectorAll('iframe')) {
				try {
					const d = f.contentDocument;
					if (d) {
						root = d.querySelector(CHAT_ROOT_SELECTOR);
						if (root) return root;
					}
				} catch {}
			}
		} catch {}
		return null;
	}
	
	let _cachedInput = null;
	function findInputEl() {
		if (_cachedInput && _cachedInput.isConnected && _cachedInput.getBoundingClientRect().width > 0) return _cachedInput;
		const scopes = [findChatRoot(), document].filter(Boolean);
		for (const scope of scopes) {
			for (const sel of INPUT_CANDIDATES) {
				const el = scope.querySelector(sel);
				if (el) { _cachedInput = el; return el; }
			}
		}
		for (const el of document.querySelectorAll('[contenteditable="true"]')) {
			const r = el.getBoundingClientRect();
			if (r.width > 100 && r.bottom > window.innerHeight * 0.5) { _cachedInput = el; return el; }
		}
		for (const ta of document.querySelectorAll('textarea')) {
			const r = ta.getBoundingClientRect();
			if (r.width > 100 && r.height > 20) { _cachedInput = ta; return ta; }
		}
		return null;
	}
	
	// 模拟键盘事件的辅助函数
	function simKey(el, type, key, code, keyCode, opts = {}) {
		const e = new KeyboardEvent(type, {
			key, code, keyCode, which: keyCode,
			bubbles: true, cancelable: true, composed: true,
			...opts
		});
		el.dispatchEvent(e);
	}

	let _pluginSettingInput = false; // 标记：插件正在设置输入框内容（区分Windsurf自带Auto-Continue）
	function setInputText(text) {
		_pluginSettingInput = true;
		setTimeout(() => { _pluginSettingInput = false; }, 2000); // 2秒后自动重置
		const inputEl = findInputEl();
		if (!inputEl) { logBubbles('找不到输入框'); return false; }
		inputEl.focus();
		if (document.activeElement !== inputEl) {
			inputEl.click();
			inputEl.focus();
		}

		if (inputEl.getAttribute('data-lexical-editor') === 'true') {
			console.log(LOG_PREFIX + '[setInputText] Lexical编辑器，开始输入"' + text + '"...');

			// ===== 策略1（最可靠）: Lexical Editor API 直接设置文本 =====
			try {
				const editorKey = Object.keys(inputEl).find(k => k.startsWith('__lexicalEditor'));
				if (editorKey) {
					const editor = inputEl[editorKey];
					if (editor && editor.update && editor.getEditorState) {
						let apiOk = false;
						editor.update(() => {
							const state = editor.getEditorState();
							state.read(() => {
								const root = state._nodeMap.get('root');
								if (!root) return;
								// 遍历所有文本节点，替换为指定文本
								const textNodes = [];
								state._nodeMap.forEach((node, key) => {
									if (node && node.__type === 'text') textNodes.push(node);
								});
								if (textNodes.length > 0) {
									// 保留第一个文本节点，删除其余
									textNodes[0].__text = text;
									for (let i = 1; i < textNodes.length; i++) {
										try { textNodes[i].remove(); } catch {}
									}
									apiOk = true;
								} else if (root.__firstChild) {
									// 有段落但无文本节点，在第一个段落中创建
									const firstPara = state._nodeMap.get(root.__firstChild);
									if (firstPara) {
										const Lexical = window.Lexical;
										if (Lexical && Lexical.$createTextNode) {
											const newNode = Lexical.$createTextNode(text);
											firstPara.clear();
											firstPara.append(newNode);
											apiOk = true;
										}
									}
								}
							});
						});
						if (apiOk) {
							inputEl.dispatchEvent(new Event('input', { bubbles: true }));
							const textAfter = (inputEl.textContent || '').replace(/\u200B/g, '').trim();
							if (textAfter === text) {
								console.log(LOG_PREFIX + '[setInputText] ✅Lexical API写入成功');
								logBubbles('已写入(Lexical-API)');
								return true;
							}
							console.log(LOG_PREFIX + '[setInputText] Lexical API设置了但验证失败(after="' + textAfter.substring(0, 30) + '")');
						}
					}
				}
			} catch (e) {
				console.log(LOG_PREFIX + '[setInputText] Lexical API异常:', e.message);
			}

			// ===== 策略2: 全选删除 + insertText =====
			try {
				// 用Selection API全选后删除（比键盘事件更可靠）
				const sel = window.getSelection();
				if (sel) {
					sel.selectAllChildren(inputEl);
					sel.deleteFromDocument();
				}
				// 等一帧让Lexical处理
				const curAfter = (inputEl.textContent || '').replace(/\u200B/g, '').trim();
				if (curAfter) {
					// Selection删除失败，尝试execCommand
					document.execCommand('selectAll');
					document.execCommand('delete');
				}
				const insertOk = document.execCommand('insertText', false, text);
				const textAfter = (inputEl.textContent || '').replace(/\u200B/g, '').trim();
				if (textAfter === text) {
					console.log(LOG_PREFIX + '[setInputText] ✅全选删除+insertText写入成功');
					logBubbles('已写入(Lexical-全选删除+insertText)');
					return true;
				}
				console.log(LOG_PREFIX + '[setInputText] insertText未生效(insertOk=' + insertOk + ', after="' + textAfter.substring(0, 30) + '")');
			} catch (e) {
				console.log(LOG_PREFIX + '[setInputText] insertText异常:', e.message);
			}

			// ===== 策略3: DOM兜底 =====
			console.log(LOG_PREFIX + '[setInputText] ⚠️所有策略均未生效，使用DOM兜底');
			inputEl.textContent = '';
			const p = document.createElement('p');
			p.textContent = text;
			inputEl.appendChild(p);
			inputEl.dispatchEvent(new Event('input', { bubbles: true }));
			logBubbles('已写入(Lexical-DOM兜底)');
			return true;
		}
		if (inputEl.contentEditable === 'true') {
			inputEl.textContent = '';
			document.execCommand('insertText', false, text);
			inputEl.dispatchEvent(new Event('input', { bubbles: true }));
			logBubbles('已写入(contenteditable)');
			return true;
		}
		if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
			const ns = Object.getOwnPropertyDescriptor(inputEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
			if (ns) ns.call(inputEl, text); else inputEl.value = text;
			inputEl.dispatchEvent(new Event('input', { bubbles: true }));
			inputEl.dispatchEvent(new Event('change', { bubbles: true }));
			logBubbles('已写入(textarea)');
			return true;
		}
		// 非Lexical非textarea的fallback：用DOM操作
		inputEl.focus();
		document.execCommand('selectAll');
		document.execCommand('delete');
		text.split('\n').forEach(line => {
			const p = document.createElement('p');
			p.textContent = line || '\u200B';
			inputEl.appendChild(p);
});
		inputEl.dispatchEvent(new Event('input', { bubbles: true }));
		logBubbles('已写入(fallback)');
		return true;
	}
	
	function findSendBtnAdvanced() {
		const root = findChatRoot();
		const scope = root || document;
		for (const sel of SEND_BTN_CANDIDATES) {
			const el = scope.querySelector(sel);
			if (el) return el;
		}
		const btns = scope.querySelectorAll('button');
		for (const btn of btns) {
			const a = (btn.getAttribute('aria-label') || '').toLowerCase();
			const t = (btn.getAttribute('title') || '').toLowerCase();
			const tt = (btn.getAttribute('data-tooltip-id') || '').toLowerCase();
			if (a.includes('send') || t.includes('send') || tt.includes('send') || a.includes('submit') || t.includes('submit')) return btn;
		}
		const inputEl = findInputEl();
		if (inputEl) {
			let container = inputEl.parentElement;
			for (let i = 0; i < 5 && container; i++) {
				const btnsNear = container.querySelectorAll('button');
				for (const btn of btnsNear) {
					const svg = btn.querySelector('svg');
					if (svg && !btn.disabled) {
						const paths = svg.querySelectorAll('path');
						if (paths.length <= 3) { logBubbles('找到输入框附近SVG按钮'); return btn; }
					}
				}
				container = container.parentElement;
			}
		}
		return null;
	}
	
	function submitBubbleText(text) {
		if (!text) return;
		setInputText(text);
		if (!settings.bubblesAutoSend) return;
		setTimeout(() => {
			const inputEl = findInputEl();
			if (!inputEl) return;
			inputEl.focus();
			try { inputEl.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true, composed: true })); } catch {}
			const targets = new Set([inputEl, inputEl.parentElement, inputEl.closest('[role="textbox"]'), document.activeElement].filter(Boolean));
			for (const t of targets) { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true })); }
			setTimeout(() => {
				const btn = findSendBtnAdvanced();
				if (btn && !btn.disabled) { btn.click(); return; }
				const scope = findChatRoot() || document;
				for (const b of scope.querySelectorAll('button')) {
					const r = b.getBoundingClientRect();
					if (r.width > 0 && r.height > 0 && !b.disabled && r.bottom > window.innerHeight * 0.7) { b.click(); return; }
				}
			}, 200);
		}, 200);
	}
	
	function renderBubblesCard(data, container) {
		const wrapper = document.createElement('div');
		wrapper.className = 'ws-bubbles';
		wrapper.dataset.wsBubblesRendered = '1';
		wrapper.style.cssText = 'pointer-events:all!important;position:relative;z-index:10;';
		
		if (data.title || data.type === 'clarify') {
			const header = document.createElement('div');
			header.className = 'ws-bubbles-header';
			const titleEl = document.createElement('div');
			titleEl.className = 'ws-bubbles-title';
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', '0 0 24 24');
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', ICON_BUBBLES);
			path.setAttribute('fill', 'currentColor');
			svg.appendChild(path);
			titleEl.appendChild(svg);
			titleEl.appendChild(document.createTextNode(data.title || 'Suggestions'));
			header.appendChild(titleEl);
			wrapper.appendChild(header);
		}
		
		if (data.type === 'clarify' && data.question) {
			const qEl = document.createElement('div');
			qEl.className = 'ws-bubbles-question';
			qEl.appendChild(document.createTextNode(data.question));
			const tag = document.createElement('span');
			tag.className = 'ws-bubbles-mode-tag';
			tag.textContent = data.mode === 'multi' ? 'Multi' : 'Single';
			qEl.appendChild(tag);
			wrapper.appendChild(qEl);
		}
		
		if (data.type === 'clarify') {
			data.items.forEach((item, i) => {
				const opt = document.createElement('div');
				opt.className = 'ws-bubble-option';
				const letter = document.createElement('span');
				letter.className = 'ws-bubble-option-letter';
				letter.textContent = LETTERS[i] || String(i + 1);
				const text = document.createElement('span');
				text.className = 'ws-bubble-option-text';
				text.textContent = item;
				opt.appendChild(letter);
				opt.appendChild(text);
				opt.style.pointerEvents = 'all';
				opt.addEventListener('click', e => {
					e.stopPropagation(); e.stopImmediatePropagation();
					submitBubbleText(LETTERS[i] + '. ' + item);
					wrapper.remove();
				});
				opt.addEventListener('mousedown', e => e.stopPropagation());
				wrapper.appendChild(opt);
			});
			const co = document.createElement('div');
			co.className = 'ws-bubble-option';
			const cl = document.createElement('span');
			cl.className = 'ws-bubble-option-letter';
			cl.textContent = '\u270F';
			cl.style.fontSize = '13px';
			const ct = document.createElement('span');
			ct.className = 'ws-bubble-option-text';
			ct.textContent = 'Custom answer...';
			ct.style.opacity = '0.5';
			ct.style.fontStyle = 'italic';
			co.appendChild(cl);
			co.appendChild(ct);
			const cir = document.createElement('div');
			cir.style.cssText = 'display:none;gap:6px;align-items:center;margin-top:6px;';
			const ci = document.createElement('input');
			ci.type = 'text';
			ci.className = 'ws-bubble-custom-input';
			ci.placeholder = 'Type your answer...';
			ci.style.flex = '1';
			const csb = document.createElement('button');
			csb.className = 'ws-bubble-custom-send';
			csb.textContent = 'Send';
			csb.addEventListener('click', () => {
				const v = ci.value.trim();
				if (v) { submitBubbleText(v); wrapper.remove(); }
			});
			ci.addEventListener('keydown', e => { if (e.key === 'Enter') csb.click(); });
			cir.appendChild(ci);
			cir.appendChild(csb);
			co.addEventListener('click', e => {
				if (e.target === ci || e.target === csb) return;
				cir.style.display = cir.style.display === 'none' ? 'flex' : 'none';
				if (cir.style.display === 'flex') setTimeout(() => ci.focus(), 50);
			});
			wrapper.appendChild(co);
			wrapper.appendChild(cir);
		} else if (data.type === 'suggest') {
			const chips = document.createElement('div');
			chips.className = 'ws-bubbles-chips';
			data.items.forEach(item => {
				const chip = document.createElement('button');
				chip.className = 'ws-bubble-chip';
				chip.style.pointerEvents = 'all';
				chip.textContent = item;
				chip.addEventListener('click', e => {
					e.stopPropagation(); e.stopImmediatePropagation();
					submitBubbleText(item);
					wrapper.remove();
				});
				chip.addEventListener('mousedown', e => e.stopPropagation());
				chips.appendChild(chip);
			});
			wrapper.appendChild(chips);
		} else {
			data.items.forEach(item => {
				const b = document.createElement('button');
				b.className = 'ws-bubble-related';
				b.style.pointerEvents = 'all';
				b.textContent = item;
				b.addEventListener('click', e => {
					e.stopPropagation(); e.stopImmediatePropagation();
					submitBubbleText(item);
					wrapper.remove();
				});
				b.addEventListener('mousedown', e => e.stopPropagation());
				wrapper.appendChild(b);
			});
		}
		
		container.appendChild(wrapper);
		
		const themeId = settings.bubblesTheme || 'emerald';
		const theme = BUBBLE_THEMES.find(t => t.id === themeId);
		if (theme && themeId !== 'emerald') {
			const S = (el, p, v) => el.style.setProperty(p, v, 'important');
			wrapper.querySelectorAll('.ws-bubble-option,.ws-bubble-chip,.ws-bubble-related').forEach(btn => {
				S(btn, 'background', theme.bg);
				S(btn, 'color', theme.color);
				S(btn, 'box-shadow', theme.shadow);
				if (theme.border && theme.border !== 'none') S(btn, 'border', theme.border); else S(btn, 'border', 'none');
				if (theme.blur) btn.style.backdropFilter = 'blur(12px)';
				btn.addEventListener('mouseenter', () => S(btn, 'background', theme.bgHover));
				btn.addEventListener('mouseleave', () => S(btn, 'background', theme.bg));
			});
			wrapper.querySelectorAll('.ws-bubble-option-letter').forEach(el => {
				S(el, 'background', theme.letterBg);
				S(el, 'color', theme.letterColor);
			});
			wrapper.querySelectorAll('.ws-bubble-option-text').forEach(el => S(el, 'color', theme.color));
			wrapper.querySelectorAll('.ws-bubbles-mode-tag').forEach(el => S(el, 'background', theme.tagBg || theme.bg));
		}
		
		const shapeId = settings.bubblesShape || 'rounded';
		const shape = BUBBLE_SHAPES.find(s => s.id === shapeId);
		if (shape) {
			wrapper.querySelectorAll('.ws-bubble-option,.ws-bubble-chip,.ws-bubble-related').forEach(btn => btn.style.setProperty('border-radius', shape.radius, 'important'));
			wrapper.querySelectorAll('.ws-bubble-option-letter').forEach(el => {
				const lr = Math.max(2, parseInt(shape.radius) - 2) + 'px';
				el.style.setProperty('border-radius', lr, 'important');
			});
		}
	}
	
	function parseBubbleMetaFromText(text, data) {
		const tm = text.match(/\btype:\s*(clarify|suggest|related)/);
		if (tm) data.type = tm[1];
		const ti = text.match(/\btitle:\s*(.+?)(?:\s+(?:type|question|mode|items):|$)/);
		if (ti) data.title = ti[1].trim();
		const qm = text.match(/\bquestion:\s*(.+?)(?:\s+(?:type|title|mode|items):|$)/);
		if (qm) data.question = qm[1].trim();
		const mm = text.match(/\bmode:\s*(single|multi)/);
		if (mm) data.mode = mm[1];
	}
	
	function findClosingMarker(openNode, openOffset, scope) {
		const sameNodeText = openNode.textContent.substring(openOffset + 10);
		const sameMatch = sameNodeText.match(/:{3}(?!bubbles)/);
		if (sameMatch) {
			return { node: openNode, offset: openOffset + 10 + sameMatch.index + 3 };
		}
		const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		w.currentNode = openNode;
		let next;
		while (next = w.nextNode()) {
			const t = next.textContent || '';
			const m = t.match(/:{3}(?!bubbles)/);
			if (m) return { node: next, offset: m.index + 3 };
		}
		return null;
	}
	
	function extractItemsInRange(range) {
		const items = [];
		const ancestor = range.commonAncestorContainer;
		const root = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
		if (!root) return items;
		
		const lis = root.querySelectorAll('li, [role="listitem"]');
		const nodeRange = document.createRange();
		lis.forEach(li => {
			try {
				nodeRange.selectNode(li);
				if (range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0 &&
				    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0) {
					let t = (li.textContent || '').trim();
					t = t.replace(/\s*:{3}\s*$/, '');
					if (t) items.push(t);
				}
			} catch (e) {}
		});
		
		if (items.length === 0) {
			const txt = range.toString();
			const lines = txt.split(/\r?\n/);
			const bulletRe = /^\s*[-*•·]\s*(\S.*)$/;
			lines.forEach(line => {
				const m = line.match(bulletRe);
				if (m) {
					let t = m[1].trim().replace(/\s*:{3}\s*$/, '');
					if (t) items.push(t);
				}
			});
		}
		
		if (items.length === 0) {
			const txt = range.toString();
			const metaRe = /^\s*(type|title|question|mode|items)\s*:/i;
			let inItems = false;
			txt.split(/\r?\n/).forEach(line => {
				if (/^\s*items\s*:/i.test(line)) { inItems = true; return; }
				if (!inItems) return;
				let t = line.trim();
				t = t.replace(/^[-*•·]\s*/, '');
				t = t.replace(/\s*:{3}\s*$/, '');
				t = t.replace(/^:{3}bubbles\s*/i, '');
				if (t && !metaRe.test(t)) items.push(t);
			});
		}
		return items;
	}
	
	function scanForBubbles(scope) {
		if (!settings.bubblesEnabled) return;
		if (!scope) scope = findChatRoot();
		if (!scope) return;
		
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		const opens = [];
		let tn;
		while (tn = walker.nextNode()) {
			const txt = tn.textContent || '';
			let idx = -1, searchFrom = 0;
			while ((idx = txt.indexOf(':::bubbles', searchFrom)) >= 0) {
				let p = tn.parentElement;
				let processed = false;
				while (p && p !== scope) {
					if (p.dataset && p.dataset.wsBubblesProcessed) { processed = true; break; }
					p = p.parentElement;
				}
				if (!processed) opens.push({ node: tn, offset: idx });
				searchFrom = idx + 10;
			}
		}
		
		for (const open of opens) {
			const close = findClosingMarker(open.node, open.offset, scope);
			if (!close) continue;
			
			const range = document.createRange();
			try {
				range.setStart(open.node, open.offset);
				range.setEnd(close.node, close.offset);
			} catch (e) { continue; }
			
			const items = extractItemsInRange(range);
			if (items.length === 0) continue;
			
			const data = { type: 'suggest', title: '', question: '', mode: 'single', items };
			const fullText = range.toString();
			const metaText = fullText.substring(fullText.indexOf(':::bubbles') + 10);
			parseBubbleMetaFromText(metaText, data);
			
			const ancestor = range.commonAncestorContainer;
			const markEl = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
			if (!markEl) continue;
			if (markEl.dataset.wsBubblesProcessed) continue;
			markEl.dataset.wsBubblesProcessed = '1';
			
			logBubbles('检测到气泡:', data.type, data.items.length, '项');
			
			const host = document.createElement('div');
			host.dataset.wsBubbleCard = '1';
			renderBubblesCard(data, host);
			
			try {
				range.deleteContents();
				range.insertNode(host);
				let cleanScope = host.parentElement;
				let depth = 0;
				while (cleanScope && cleanScope !== scope && depth < 4) {
					cleanScope.querySelectorAll('ul, ol, li, p').forEach(el => {
						if (el !== host && !el.contains(host) && !(el.textContent || '').trim() && !el.querySelector('img, svg, video, canvas')) {
							el.remove();
						}
					});
					cleanScope = cleanScope.parentElement;
					depth++;
				}
			} catch (e) {
				logBubbles('插入失败，回退:', e.message);
				const target = markEl.closest('p, div, li, section, article') || markEl;
				if (target.parentElement) {
					target.parentElement.insertBefore(host, target.nextSibling);
				}
			}
		}
	}
	
	let bubblesObserver = null;
	let _bubblesScope = null;
	let _bubblesTimer = 0;

	function startBubblesObserving() {
		if (bubblesObserver) { bubblesObserver = null; }
		if (!settings.bubblesEnabled) return;
		const scope = findChatRoot();
		if (!scope) {
			logBubbles('聊天根未找到，稍后重试');
			setTimeout(startBubblesObserving, 2000);
			return;
		}
		logBubbles('✅已找到聊天根，开始监听');
		_bubblesScope = scope;
		scanForBubbles(scope);
		// 由统一观察器接管触发，此处仅记录scope
	}

	function onBubblesMutation() {
		if (!_bubblesScope || !settings.bubblesEnabled) return;
		clearTimeout(_bubblesTimer);
		_bubblesTimer = setTimeout(() => scanForBubbles(_bubblesScope), 500);
	}
	
	// ========== 汉化功能 ==========
	const EXCLUDE_SELECTOR = '.monaco-editor, pre, code, textarea, input, [contenteditable="true"], .xterm, .terminal, .debug-console, .ws-bubbles, .ws-better-panel';
	const ATTRS_TO_TRANSLATE = ['aria-label', 'title', 'placeholder', 'data-tooltip'];
	
	const TRANSLATIONS = new Map([
		// ========== Section 标题 ==========
		['User Interface', '用户界面'],
		['Windsurf Tab', 'Windsurf 补全'],
		['Shortcuts', '快捷键'],
		['Advanced', '高级'],
		['General', '通用'],
		['Editor', '编辑器'],
		['Cascade', 'Cascade'],
		['Cascade Configuration', 'Cascade 配置'],
		['Notifications', '通知'],
		['Agent', '智能体'],
		['Agents', '智能体'],
		['Settings', '设置'],
		['Account', '账户'],
		['Profile', '个人资料'],
		['Subscription', '订阅'],
		
		// ========== User Interface 设置 ==========
		['Show Inlay Shortcuts', '显示内联快捷键'],
		['Show in-line shortcut actions while the cursor is on an empty line', '当光标在空行上时，显示行内快捷操作'],
		['Show Explain Problem Inlay Hint', '显示问题解释内联提示'],
		['Show in-line explain problem actions while the cursor is on a line with an error squiggle', '当光标所在行有错误波浪线时，在行内显示解释问题的操作'],
		['Show Selection Popup', '显示选区弹窗'],
		['Show clickable shortcut popup when selecting text', '选中文本时显示浮动快捷弹窗'],
		['Scroll to Next Diff on Accept', '接受时滚动到下一个差异'],
		['Automatically scroll to the next Diff when accepting the current one', '接受当前差异时自动滚动到下一个差异'],
		
		// ========== Windsurf Tab 设置 ==========
		['Completion Mode', '补全模式'],
		['Choose your preferred code completion experience', '选择你偏好的代码补全体验'],
		['Aggression', '主动程度'],
		['Controls how proactively Supercomplete suggests edits near your cursor', '控制 Supercomplete 在光标附近主动建议编辑的频率'],
		['Tab to Jump', 'Tab 跳转'],
		['Predict the location of your next edit and navigates you there with a tab keypress', '预测下一个编辑位置，按 Tab 跳转到该位置'],
		['Tab to Import', 'Tab 导入'],
		['Quickly add and update imports with a tab keypress', '按 Tab 快速添加和更新导入语句'],
		['Clipboard Context', '剪贴板上下文'],
		['When enabled, Windsurf will use the clipboard as context for completions', '启用后，Windsurf 将使用剪贴板内容作为补全的上下文'],
		['Auto-Generate Memories', '自动生成记忆'],
		['When enabled, Cascade will autonomously generate memories to remember important context. When disabled, Cascade will only create memories when you explicitly ask', '启用后，Cascade 将自动生成记忆以记住重要上下文。禁用后，Cascade 仅在你明确要求时创建记忆'],
		['Allow Cascade in Background', '允许 Cascade 在后台运行'],
		['When enabled, Windsurf will allow Cascade to run in the background. When disabled, switching conversations will stop Cascade. Terminal commands may run in the background depending on your Terminal Auto Execution setting', '启用后，Windsurf 允许 Cascade 在后台运行。禁用后，切换对话将停止 Cascade。终端命令可能根据你的终端自动执行设置在后台运行'],
		['Auto-Continue', '自动继续'],
		['Controls whether Cascade automatically continues when it reaches the invocation limit. When on, Cascade continues indefinitely without prompting. When off, Cascade stops at the invocation limit and asks you to continue', '控制 Cascade 达到调用限制时是否自动继续。开启时，Cascade 无限期继续而无需提示。关闭时，Cascade 在调用限制处停止并询问你是否继续'],
		['Disable Fast Context Agent', '禁用快速上下文智能体'],
		['Disable the Fast Context agent that executes parallel searches as a subagent', '禁用执行并行搜索的快速上下文智能体'],
		['Arena Always Open Fullscreen', 'Arena 始终全屏打开'],
		['When enabled, Arena mode sessions will automatically open in the editor tab for a side-by-side view', '启用后，Arena 模式会话将自动在编辑器标签页中打开以进行并排视图'],
		['Cascade Completion Notifications', 'Cascade 完成通知'],
		['Show notifications when a Cascade finishes while in the background', '当 Cascade 在后台完成时显示通知'],
		['Always Notify on Cascade Completion', '始终通知 Cascade 完成'],
		['Show notifications when a Cascade finishes, even when the panel is open and focused', '当 Cascade 完成时显示通知，即使面板已打开且处于焦点状态'],
		['Read Claude Code Config', '读取 Claude Code 配置'],
		['When enabled, Cascade will read skills from .claude directories (both local .claude/skills/ and global ~/.claude/skills/)', '启用后，Cascade 将从 .claude 目录读取技能（包括本地 .claude/skills/ 和全局 ~/.claude/skills/）'],
		
		// ========== Cascade Configuration 设置 ==========
		['Explain and Fix in Current Conversation', '在当前对话中解释和修复'],
		['Send explain and fix request to the current conversation', '向当前对话发送解释和修复请求'],
		['Gitignore access', 'Gitignore 访问权限'],
		['Allow Cascade, tab, and supercomplete to view and edit the files in .gitignore', '允许 Cascade、tab 和 supercomplete 查看和编辑 .gitignore 中的文件'],
		['Cascade Auto-Fix Lints', 'Cascade 自动修复 Lint 错误'],
		['When enabled, Cascade is given awareness of lint errors created by its edits and may fix them without explicit user prompting. Note that this may increase Cascade\'s tool usage', '启用后，Cascade 会感知自身编辑引发的 lint 错误，并可能自动修复。注意：这可能会增加工具调用次数'],
		['Windsurf Preview', 'Windsurf 预览'],
		['When enabled, Cascade will be able to open local browser previews of sites running on development servers that Cascade has started. These browser previews provide special functionalities to integrate Cascade more tightly in the development cycle', '启用后，Cascade 可以打开其启动的开发服务器的本地浏览器预览，让 Cascade 更深度参与开发流程'],
		['Auto Execution', '自动执行'],
		['Disabled - All terminal commands require manual approval', '已禁用 - 所有终端命令需要手动批准'],
		['Auto Web Requests', '自动 Web 请求'],
		['Disabled - All web requests require manual approval', '已禁用 - 所有 Web 请求需要手动批准'],
		
		// ========== Advanced 设置 ==========
		['Search Max Workspace File Count', '最大工作区文件搜索数'],
		['Windsurf will attempt to compute embeddings for workspaces up to this many files. This file count ignores .gitignore and binary files. Raising this limit from the default value may lead to performance issues. Values 0 or below will be treated as unlimited', 'Windsurf 会对不超过此文件数的工作区生成索引（不含 .gitignore 和二进制文件）。调高此值可能影响性能，设为 0 或负数表示无限制'],
		['Open Editor Settings', '打开编辑器设置'],
		['For general editor settings, visit the Editor Settings Page', '对于常规编辑器设置，请访问编辑器设置页面'],
		['Customize Application Icon', '自定义应用图标'],
		['Choose your Windsurf Application Icon among a few custom presets', '从几个自定义预设中选择你的 Windsurf 应用图标'],
		['Enable ACP', '启用 ACP'],
		['Enable or disable ACP (Agent Client Protocol) entirely. When off, no agents are instantiated', '完全启用或禁用 ACP（代理客户端协议）。关闭时，不会实例化任何代理'],
		['Marketplace Extension Gallery Service URL', 'Marketplace 扩展库服务 URL'],
		['Change the base URL for marketplace search results. You must restart Windsurf to use the new marketplace after changing the value', '更改 marketplace 搜索结果的基础 URL。更改值后必须重启 Windsurf 才能使用新的 marketplace'],
		['Marketplace Gallery Item URL', 'Marketplace 库项目 URL'],
		['Changes the base URL on each extension page. You must restart Windsurf to use the new marketplace after changing this value', '更改每个扩展页面的基础 URL。更改值后必须重启 Windsurf 才能使用新的 marketplace'],
		
		// ========== Shortcuts 设置 ==========
		['Open Command', '打开命令'],
		['Open Chat with Cascade', '打开 Cascade 聊天'],
		['View All Windsurf shortcuts', '查看所有 Windsurf 快捷键'],
		['Open Command Palette', '打开命令面板'],
		['Change keybindings', '修改快捷键'],
		['Keyboard Shortcuts', '键盘快捷键'],
		['Reset to default shortcuts', '重置为默认快捷键'],
		['Reset to defaults', '重置为默认'],
		
		// ========== 选项值 ==========
		['Low', '低'],
		['Conservative suggestions with higher confidence', '保守的建议，置信度更高'],
		['Medium', '中等'],
		['Balanced suggestions', '平衡的建议'],
		['High', '高'],
		['More frequent and ambitious suggestions', '更频繁、更大胆的建议'],
		['Supercomplete', '超级补全'],
		['Intelligent edit suggestions near your cursor', '光标附近的智能编辑建议'],
		['Autocomplete', '自动补全'],
		['Standard inline completions without side hint code box suggestions', '标准内联补全，不含侧边代码提示框'],
		['OFF', '关闭'],
		['Disable all code completions', '禁用所有代码补全'],
		['Disabled', '已禁用'],
		['Auto-execution is disabled for all commands', '所有命令的自动执行已禁用'],
		['Auto-fetching is disabled for all web requests', '所有 Web 请求的自动获取已禁用'],
		['Allowlist', '允许列表'],
		['Never auto-execute commands unless they are in your allow list', '除非命令在你的允许列表中，否则不自动执行'],
		['Only auto-fetch URLs from origins in your allow list', '仅自动获取允许列表中来源的 URL'],
		['Auto', '自动'],
		['Cascade model will decide which commands are safe to auto-execute. This is only available for premium models', 'Cascade 模型将决定哪些命令可以安全地自动执行。此功能仅适用于高级模型'],
		['Turbo', '极速'],
		['Always auto-execute commands unless they are in your deny list. This also allows Cascade to auto-execute Browser controls', '自动执行命令，除非在拒绝列表中。同时允许 Cascade 自动控制浏览器'],
		['Always auto-fetch all web requests', '始终自动获取所有 Web 请求'],
		
		// ========== 通用选项 ==========
		['On', '开启'],
		['Off', '关闭'],
		['Enabled', '已启用'],
		['Yes', '是'],
		['No', '否'],
		['None', '无'],
		['Default', '默认'],
		['Custom', '自定义'],
		['Manual', '手动'],
		
		// ========== 其他界面文本 ==========
		['Search settings...', '搜索设置...'],
		['Search settings', '搜索设置'],
		['Log in to Windsurf', '登录 Windsurf'],
		['Getting started with Windsurf', '开始使用 Windsurf'],
		['Code with Cascade', '使用 Cascade 编码'],
		['Edit code inline', '内联编辑代码'],
		['Open Agent Window', '打开智能体窗口'],
		['Thought', '思考'],
		['Created Todo List', '已创建任务列表'],
		['Analyzed content', '已分析内容'],
		['tasks done', '任务完成'],
		['chunks', '分片'],
		['Failed to fetch document content at', '无法获取文档内容：'],
		['Markdown', 'Markdown'],
		['UTF-8', 'UTF-8'],
		['Ctrl', 'Ctrl'],
		['Shift', 'Shift'],
		['Alt', 'Alt'],
		['Cmd', 'Cmd'],
		['Win', 'Win'],
		['Detect Proxy', '自动检测代理'],
		['Enable automatic proxy detection. Toggling this will force Windsurf to reload', '启用自动代理检测。切换此选项将强制 Windsurf 重新加载'],
		// ========== Devin Desktop 侧边栏/顶部栏 ==========
		['New session', '新建会话'],
		['Sessions', '会话'],
		['Review', '审查'],
		['Automations', '自动化'],
		['Security', '安全'],
		['Wiki', 'Wiki'],
		['Cloud settings', '云端设置'],
		['Spaces', '空间'],
		['Board', '看板'],
		['List', '列表'],
		['Display', '显示'],
		['New Agent Window', '新建智能体窗口'],
		['Agent', '智能体'],
		['Editor', '编辑器'],
		['Search sessions...', '搜索会话...'],
		['Running', '运行中'],
		['Time is', '时间为'],
		['Archived is', '已归档为'],
		['Excluded', '已排除'],
		['Included', '已包含'],
		['Any time', '任意时间'],
		// ========== MCP 相关 ==========
		['MCP Servers', 'MCP 服务器'],
		['Browse and install MCP servers', '浏览并安装 MCP 服务器'],
		['Open MCP Registry', '打开 MCP 注册表'],
		['Manage installed servers', '管理已安装的服务器'],
		['Install', '安装'],
		['Uninstall', '卸载'],
		['Server URL', '服务器 URL'],
		['Command', '命令'],
		['Environment Variables', '环境变量'],
		['Arguments', '参数'],
		['Headers', '请求头'],
		['Getting Started', '入门指南'],
		['No tools found', '未找到工具'],
		['All Tools', '所有工具'],
		['No description available', '无可用描述'],
		['required', '必需'],
		['secret', '机密'],
		['Remote Endpoints', '远程端点'],
		['Click **Install** to add this MCP server to your configuration', '点击 **安装** 将此 MCP 服务器添加到你的配置'],
		['Set the required environment variables below', '在下方设置必需的环境变量'],
		['The server\'s tools will be available in Cascade', '服务器的工具将在 Cascade 中可用'],

		// ========== Plan 和 Quota 相关 ==========
		['Plan ends', '套餐到期'],
		['Daily quota usage', '每日配额使用'],
		['Weekly quota usage', '每周配额使用'],
		['Extra usage balance', '额外使用余额'],
		['Purchase extra usage', '购买额外使用量'],
		['Auto refill settings', '自动充值设置'],
		['Configure auto refill', '配置自动充值'],
		['Manage your plan', '管理你的套餐'],
		['Upgrade', '升级'],
		['Downgrade', '降级'],
		['Cancel', '取消'],
		['Billing', '账单'],
		['Payment method', '支付方式'],
		['Invoice', '发票'],
		['Usage', '使用量'],
		['Resets daily', '每日重置'],
		['Resets weekly', '每周重置'],
		['Resets monthly', '每月重置'],
		['Trial', '试用'],
		['Free', '免费'],
		['Pro', '专业版'],
		['Plan Info', '套餐信息'],

		// ========== 右键菜单 / 面板菜单 ==========
		['Open Preview', '打开预览'],
		['Deploy', '部署'],
		['Download Trajectory', '下载对话记录'],
		['Cascade Usage', 'Cascade 使用量'],
		['Download Diagnostics', '下载诊断信息'],
		['Configure Rules', '配置规则'],
		['Configure Skills', '配置技能'],
		['Configure Workflows', '配置工作流'],
		['Edit Memories', '编辑记忆'],
		['MCPs', 'MCP 服务'],

		// ========== Customizations 页面 ==========
		['Customizations', '自定义'],
		['Customize Cascade to get a better, more personalized experience.', '自定义 Cascade，打造更个性化的体验。'],
		['Customize Cascade to get a better, more personalized experience', '自定义 Cascade，打造更个性化的体验'],
		['Learn more', '了解更多'],
		['Rules', '规则'],
		['Skills', '技能'],
		['Workflows', '工作流'],
		['Memories', '记忆'],
		['Rules help guide the behavior of Cascade. Global rules are automatically included in memory.', '规则帮助引导 Cascade 的行为。全局规则会自动包含在记忆中。'],
		['Workspace', '工作区'],
		['Global', '全局'],
		['Back', '返回'],
		['Cascade Rules', 'Cascade 规则'],
		['Rules help guide the behavior of Cascade.', '规则帮助引导 Cascade 的行为。'],
		['Manage rules', '管理规则'],
		['Workflows are saved prompts that Cascade can follow. To trigger a workflow, type "/" in Cascade.', '工作流是 Cascade 可以遵循的已保存提示。要触发工作流，在 Cascade 中输入 "/"。'],
		['Manage workflows', '管理工作流'],
		['Cascade Memories', 'Cascade 记忆'],
		['View and edit Cascade generated memories', '查看和编辑 Cascade 生成的记忆'],
		['View memories', '查看记忆'],
		['Manage', '管理'],
		['Search memories', '搜索记忆'],
		['Memories are automatically generated by Cascade to maintain context between conversations.', '记忆由 Cascade 自动生成，用于在对话之间保持上下文。'],
		['No auto-generated memories', '暂无自动生成的记忆'],

		// ========== Configuration 设置（截图3: 描述文本） ==========
		['Configuration', '配置'],
		['When enabled, Windsurf will allow Cascade to run in the background. When disabled, switching conversations will stop Cascade. Terminal commands may run in the background depending on your Terminal Auto Execution setting.', '启用后，Windsurf 允许 Cascade 在后台运行。禁用后，切换对话将停止 Cascade。终端命令可能根据你的终端自动执行设置在后台运行。'],
		['When enabled, Arena mode sessions will automatically open in the editor tab for a side-by-side view.', '启用后，Arena 模式会话将自动在编辑器标签页中打开以进行并排视图。'],
		['Show Allow/Deny list', '显示 允许/拒绝 列表'],
		['Show Allowlist', '显示允许列表'],
		['Disabled - All terminal commands require manual approval.', '已禁用 - 所有终端命令需要手动批准。'],
		['Allowlist - Only allowlisted terminal commands are auto-executed.', '允许列表 - 仅允许列表中的终端命令会自动执行。'],
		['Auto - The model decides whether to auto-execute a command (premium models only)', '自动 - 模型决定是否自动执行命令（仅限高级模型）'],
		['Turbo - All terminal commands are auto-executed (except those in the denylist)', '极速 - 所有终端命令自动执行（拒绝列表中的除外）'],
		['Disabled - All web requests require manual approval.', '已禁用 - 所有 Web 请求需要手动批准。'],
		['Allowlist - Only allowlisted origins are auto-fetched.', '允许列表 - 仅自动获取允许列表中来源的请求。'],
		['Turbo - All web requests are auto-fetched.', '极速 - 所有 Web 请求自动获取。'],
		['Controls whether Cascade automatically continues when it reaches the invocation limit. When on, Cascade continues indefinitely without prompting. When off, Cascade stops at the invocation limit and asks you to continue.', '控制 Cascade 达到调用限制时是否自动继续。开启时，Cascade 无限期继续而无需提示。关闭时，Cascade 在调用限制处停止并询问你是否继续。'],
		['When enabled, Cascade will autonomously generate memories to remember important context. When disabled, Cascade will only create memories when you explicitly ask.', '启用后，Cascade 将自动生成记忆以记住重要上下文。禁用后，Cascade 仅在你明确要求时创建记忆。'],
		['Auto-Open Edited Files', '自动打开编辑的文件'],
		['Open files in the background if Cascade creates or edits them', '如果 Cascade 创建或编辑了文件，则在后台打开它们'],
		['When enabled, Cascade is given awareness of lint errors created by its edits and may fix them without explicit user prompting. Note that this may increase Cascade\'s tool usage.', '启用后，Cascade 会感知自身编辑引发的 lint 错误，并可能自动修复。注意：这可能会增加工具调用次数。'],

		// ========== 截图4: Enable Cascade Web Tools 等 ==========
		['Enable Cascade Web Tools', '启用 Cascade Web 工具'],
		['When enabled, Cascade can perform web searches on the open Internet. This does not affect Cascade\'s ability to read specific URLs, which is performed locally on your machine.', '启用后，Cascade 可以在互联网上执行 Web 搜索。这不影响 Cascade 读取特定 URL 的能力，该操作在本地执行。'],
		['Send explain and fix request to the current conversation.', '向当前对话发送解释和修复请求。'],
		['Allow Cascade, tab, and supercomplete to view and edit the files in .gitignore.', '允许 Cascade、Tab 和超级补全查看和编辑 .gitignore 中的文件。'],
		['When enabled, Cascade will read skills from .claude directories (both local .claude/skills/ and global ~/.claude/skills/).', '启用后，Cascade 将从 .claude 目录读取技能（包括本地 .claude/skills/ 和全局 ~/.claude/skills/）。'],
		['When enabled, Cascade will be able to open local browser previews of sites running on development servers that Cascade has started. These browser previews provide special functionalities to integrate Cascade more tightly in the development cycle.', '启用后，Cascade 可以打开其启动的开发服务器的本地浏览器预览，让 Cascade 更深度参与开发流程。'],
		['Disable the Fast Context agent that executes parallel searches as a subagent.', '禁用执行并行搜索的快速上下文子智能体。'],

		// ========== 截图5: Devin for Terminal ==========
		['Devin for Terminal', 'Devin 终端'],
		['Patterns for tools/commands that are always allowed.', '始终允许的工具/命令模式。'],
		['Patterns for tools/commands that are always denied.', '始终拒绝的工具/命令模式。'],
		['Patterns for tools/commands that require confirmation.', '需要确认的工具/命令模式。'],
		['Allow', '允许'],
		['Deny', '拒绝'],
		['Ask', '询问'],
		['Add Item', '添加项'],
		['Open config.json in editor', '在编辑器中打开 config.json'],

		// ========== 截图6: 高级页 ==========
		['Enable automatic proxy detection. Toggling this will force Windsurf to reload.', '启用自动代理检测。切换此选项将强制 Windsurf 重新加载。'],
		['Windsurf will attempt to compute embeddings for workspaces up to this many files. This file count ignores .gitignore and binary files. Raising this limit from the default value may lead to performance issues. Values 0 or below will be treated as unlimited.', 'Windsurf 会对不超过此文件数的工作区生成索引（不含 .gitignore 和二进制文件）。调高此值可能影响性能，设为 0 或负数表示无限制。'],
		['Enable or disable ACP (Agent Client Protocol) entirely. When off, no agents are instantiated.', '完全启用或禁用 ACP（代理客户端协议）。关闭时，不会实例化任何代理。'],

		// ========== 截图2: 设置页描述文本 ==========
		['Change the base URL for marketplace search results. You must restart Windsurf to use the new marketplace after changing the value.', '更改 Marketplace 搜索结果的基础 URL。更改值后必须重启 Windsurf 才能使用新的 Marketplace。'],
		['Available marketplace options.', '可用的 Marketplace 选项。'],
		['Changes the base URL on each extension page. You must restart Windsurf to use the new marketplace after changing this value.', '更改每个扩展页面的基础 URL。更改值后必须重启 Windsurf 才能使用新的 Marketplace。'],
		['Available options.', '可用选项。'],
		['Browse and install MCP servers from the Cascade MCP store. Manage installed MCPs including enabling or disabling them at both server and individual tool level.', '从 Cascade MCP 商店浏览并安装 MCP 服务器。管理已安装的 MCP，包括在服务器和单个工具级别启用或禁用它们。'],

		// ========== 截图3: 面板设置 ==========
		['Advanced Settings', '高级设置'],
		['AI Shortcuts', 'AI 快捷键'],

		// ========== 通用操作 ==========
		['Save', '保存'],
		['Delete', '删除'],
		['Edit', '编辑'],
		['Close', '关闭'],
		['Apply', '应用'],
		['Reset', '重置'],
		['Confirm', '确认'],
		['Search', '搜索'],
		['Refresh', '刷新'],
		['Copy', '复制'],
		['Paste', '粘贴'],
		['Undo', '撤销'],
		['Redo', '重做'],
		['Error', '错误'],
		['Warning', '警告'],
		['Info', '信息'],
		['Success', '成功'],
		['Loading', '加载中'],
		['Retry', '重试'],

		// ========== 模型选择相关 ==========
		['Search all models', '搜索所有模型'],
		['Group by', '分组'],
		['Adaptive', '自适应'],
		['Automatically balances quality and cost', '自动平衡质量和成本'],
		['Recently Used', '最近使用'],
		['Recommended', '推荐'],
		['New', '新'],
		['context', '上下文'],
		['Thinking', '思考'],
		['Cost', '成本'],
		['Higher effort consumes more tokens', '越高越消耗 tokens'],
		['Input', '输入'],
		['Cached input', '缓存输入'],
		['Effort', '推理强度'],
		['Output', '输出'],
		['tokens', 'tokens'],

		// ========== 聊天模式相关 ==========
		['Code', '代码'],
		['Can write and edit code', '可以编写和编辑代码'],
		['Reads but won\'t edit', '读取但不会编辑'],
		['Plan changes before implementing', '先规划，再实施'],
		['Use', '使用'],
		['to switch modes', '切换模式'],
		['Ask anything', '询问任何问题'],
		['Single', '单模型'],
		['Arena', '竞技场'],

		// ========== 输入框菜单 ==========
		['Mentions', '提及'],
		['Trigger Workflow', '触发工作流'],
		['Upload Image', '上传图片'],

		// ========== 顶部标签和按钮 ==========
		['Chat', '聊天'],
		['Composer', '编排'],
		['Documentation', '文档'],
		['Commit', '提交'],
		['Continue', '继续'],
		['Accept', '接受'],
		['Reject', '拒绝'],
		['Generating', '生成中'],
		['Complete', '完成'],
		['Insert', '插入'],

		// ========== AI补全相关 ==========
		['Codeium', 'Codeium'],
		['Generating code...', '正在生成代码...'],
		['Tab to accept', '按 Tab 接受'],
		['Press Tab to accept', '按 Tab 接受'],
		['for more options', '查看更多选项'],
		['Show next', '显示下一个'],
		['Show previous', '显示上一个'],

		// ========== 文件/编辑器相关 ==========
		['New File', '新文件'],
		['New Folder', '新文件夹'],
		['Open File', '打开文件'],
		['Open Folder', '打开文件夹'],
		['Save All', '保存全部'],
		['Close Editor', '关闭编辑器'],
		['Close All', '关闭全部'],
		['Split Editor', '拆分编辑器'],
		['Go to File', '转到文件'],
		['Go to Symbol', '转到符号'],
		['Find in Files', '在文件中查找'],
		['Replace in Files', '在文件中替换'],
		['Recent Files', '最近的文件'],
		['Clear Recent', '清除最近'],

		// ========== 终端相关 ==========
		['Terminal', '终端'],
		['New Terminal', '新建终端'],
		['Split Terminal', '拆分终端'],
		['Kill Terminal', '关闭终端'],
		['Clear', '清除'],
		['Scroll to bottom', '滚动到底部'],

		// ========== 状态相关 ==========
		['Ready', '就绪'],
		['Busy', '忙碌'],
		['Disconnected', '已断开'],
		['Connecting', '连接中'],
		['Syncing', '同步中'],
		['Indexing', '索引中'],
		['Analyzing', '分析中'],
		['Building', '构建中'],
		['Testing', '测试中'],
		['Debugging', '调试中'],

		// ========== Git相关 ==========
		['Source Control', '源代码管理'],
		['Changes', '更改'],
		['Staged Changes', '暂存更改'],
		['Untracked', '未跟踪'],
		['Modified', '已修改'],
		['Added', '已添加'],
		['Deleted', '已删除'],
		['Renamed', '已重命名'],
		['Message', '消息'],
		['Stage All', '全部暂存'],
		['Unstage All', '全部取消暂存'],
		['Discard Changes', '放弃更改'],
		['View Changes', '查看更改'],
		['Pull', '拉取'],
		['Push', '推送'],
		['Fetch', '获取'],
		['Sync', '同步'],
		['Branch', '分支'],
		['Create Branch', '创建分支'],
		['Switch Branch', '切换分支'],
		['Merge Branch', '合并分支'],
		['Delete Branch', '删除分支'],
		['Checkout', '签出'],
		['Cherry-pick', '遴选'],
		['Revert', '还原'],
		['Stash', '贮藏'],
		['Stash All', '全部贮藏'],
		['Pop Stash', '弹出贮藏'],
		['Drop Stash', '删除贮藏'],
		// ========== Settings 左侧菜单补充 ==========
		['Plan information', '套餐信息'],
		['Extensions', '扩展'],
		['Devin Local', 'Devin 本地'],
		['User interface', '用户界面'],
		['Devin Tab', 'Devin Tab'],

		// ========== General 页面 ==========
		['General editor preferences open in a separate page', '通用编辑器首选项在单独页面打开'],
		['Open editor settings', '打开编辑器设置'],
		['Current plan', '当前套餐'],

		// ========== Devin Tab 设置页 ==========
		['Auto-continue', '自动继续'],
		['Devin continues past the invocation limit without prompting; otherwise it stops and asks you to continue', 'Devin 会继续执行直到调用上限而不再提示；否则会停止并询问你是否继续'],
		['Auto-fix lints', '自动修复 Lint 错误'],
		['Devin detects lint errors from its own edits and may fix them automatically. May increase tool usage', 'Devin 会检测自身编辑引发的 lint 错误并可能自动修复，可能增加工具调用次数'],
		['Enable Fast Context', '启用快速上下文'],
		['Allow Devin\'s Fast Context agent to retrieve relevant code with SWE-grep', '允许 Devin 的快速上下文智能体使用 SWE-grep 检索相关代码'],
		['Let Devin view and edit files in .gitignore', '允许 Devin 查看和编辑 .gitignore 中的文件'],
		['Clipboard context', '剪贴板上下文'],
		['Devin uses your clipboard as context for completions', 'Devin 使用你的剪贴板作为补全的上下文'],
		['Completion mode', '补全模式'],
		['Tab to import', 'Tab 导入'],
		['Add and update imports with a tab keypress', '按 Tab 添加和更新导入语句'],
		['Tab to jump', 'Tab 跳转'],
		['Predicts your next edit location and jumps there when you press tab', '预测下一个编辑位置，按 Tab 跳转到该位置'],
		['Share terminal activity', '共享终端活动'],
		['Let Devin see commands and output from your integrated terminal', '允许 Devin 查看集成终端中的命令和输出'],
		['Share user edits', '共享用户编辑'],
		['Let Devin see which files you edit and create in your workspace', '允许 Devin 查看你在工作区编辑和创建的文件'],
		['Agent Command Center location', '智能体命令中心位置'],
		['Where the Agent Command Center opens', '智能体命令中心的打开位置'],
		['Current window', '当前窗口'],
		['Agent notifications', '智能体通知'],
		['Notify when an agent session finishes or needs your input while in the background', '当智能体会话在后台完成或需要你输入时通知'],
		['Remote agent hosts', '远程智能体主机'],
		['Connect to agents on remote machines over SSH', '通过 SSH 连接到远程机器上的智能体'],
		['Connect on startup', '启动时连接'],

		// ========== Extensions 页面 ==========
		['Marketplace extension gallery service URL', 'Marketplace 扩展库服务 URL'],
		['Base URL for marketplace search results. Restart Devin to use the new marketplace', 'Marketplace 搜索结果的基础 URL。重启 Devin 以使用新的 Marketplace'],
		['Available marketplace options', '可用的 Marketplace 选项'],
		['Marketplace gallery item URL', 'Marketplace 库项目 URL'],
		['Base URL on each extension page. Restart Devin to use the new marketplace', '每个扩展页面的基础 URL。重启 Devin 以使用新的 Marketplace'],
		['Available options', '可用选项'],
		['Using Open VSX mirror (change here).', '正在使用 Open VSX 镜像（点此更改）。'],
		['(click to dismiss)', '（点击关闭）'],
		['Disable Auto Update for Extensions', '禁用扩展自动更新'],
		['启用所有扩展', '启用所有扩展'],

		// ========== Devin Desktop 设置页 ==========
		['Back to organization', '返回组织'],
		['Manage your Devin Desktop API keys and privacy settings.', '管理你的 Devin 桌面版 API 密钥和隐私设置。'],
		['Account activity', '账户活动'],
		['View account activity on windsurf.com', '在 windsurf.com 查看账户活动'],
		['View usage', '查看使用量'],
		['Models', '模型'],
		['Configure which AI models are available and how they\'re used', '配置哪些 AI 模型可用以及如何使用'],
		['Enable access to OpenAI models with data retention', '启用对具有数据保留的 OpenAI 模型的访问'],
		['Unlocks additional OpenAI models that require data retention for trust and safety verification.', '解锁需要数据保留以进行信任和安全验证的其他 OpenAI 模型。'],
		['OpenAI stores this data for up to 30 days and does not use it for model training or improvement. This setting applies only to OpenAI models.', 'OpenAI 最多存储此数据 30 天，不会用于模型训练或改进。此设置仅适用于 OpenAI 模型。'],
		['Shared conversations', '共享对话'],
		['Beta', '测试版'],
		['Manage Devin Local sessions you\'ve shared', '管理你共享的 Devin 本地会话'],
		['Source', '来源'],
		['No shared conversations', '暂无共享对话'],
		['Conversations you share from Devin Local will appear here.', '你从 Devin 本地共享的对话将显示在此处。'],
		['Shared codemaps', '共享代码地图'],
		['Manage codemaps you\'ve shared from Devin Desktop', '管理你从 Devin 桌面版共享的代码地图'],
		['Created at', '创建时间'],
		['No shared codemaps', '暂无共享代码地图'],
		['Codemaps you share from Devin Desktop will appear here.', '你从 Devin 桌面版共享的代码地图将显示在此处。'],
		['Team shared codemaps', '团队共享代码地图'],
		['Codemaps shared with your team by other members', '其他成员与团队共享的代码地图'],
		['Owner', '所有者'],
		['No team codemaps', '暂无团队代码地图'],
		['Codemaps shared with your team will appear here.', '与团队共享的代码地图将显示在此处。'],
		['Model provider API keys', '模型提供商 API 密钥'],
		['Anthropic API key', 'Anthropic API 密钥'],
		['Your Anthropic API key will be used to power Claude models in Devin Desktop. You can manage your API keys in the Anthropic console.', '你的 Anthropic API 密钥将用于驱动 Devin 桌面版中的 Claude 模型。你可以在 Anthropic 控制台中管理 API 密钥。'],

		// ========== Security 页面 ==========
		['Security', '安全'],
		['Scans', '扫描'],
		['Profiles', '配置文件'],
		['Start scan', '开始扫描'],
		['No scans yet', '暂无扫描'],
		['Start a scan to search for findings across your repositories.', '开始扫描以搜索仓库中的问题。'],

		// ========== Automations 页面 ==========
		['Introducing Automations', '介绍自动化'],
		['Trigger on events or schedules to investigate issues, generate insights, and create pull requests automatically.', '基于事件或计划触发，自动调查问题、生成洞察并创建拉取请求。'],
		['Key features', '主要功能'],
		['Event-based triggers', '基于事件的触发器'],
		['Automatically run Devin from supported integrations or your own systems using custom webhooks', '从支持的集成或你自己的系统使用自定义 Webhook 自动运行 Devin'],
		['Scheduled triggers', '计划触发器'],
		['Have Devin handle workloads on any recurring date or time interval', '让 Devin 在任意循环日期或时间间隔处理工作负载'],
		['Persistent Memory', '持久记忆'],
		['Use scratchpad to persist state and knowledge across automation runs', '使用暂存区在自动化运行之间持久保存状态和知识'],
		['Bring Devin into your recurring and event-driven workflows', '将 Devin 引入你的循环和事件驱动工作流'],
		['Mine', '我的'],
		['Create automation', '创建自动化'],
		['Generate with Devin', '用 Devin 生成'],
		['Describe what automation you want to build', '描述你想构建的自动化'],
		['Create manually', '手动创建'],
		['Configure automation triggers, actions, and limits yourself', '自己配置自动化触发器、操作和限制'],
		['Create from template', '从模板创建'],
		['Customize a preset automation to fit your needs', '自定义预设自动化以满足你的需求'],
		['Suggested automations', '推荐的自动化'],
		['Monitoring & Triage', '监控和分类'],
		['CI/CD & Release', 'CI/CD 和发布'],
		['Project Management', '项目管理'],
		['Triage Bug Reports', '分类 Bug 报告'],
		['Triage Support Requests', '分类支持请求'],
		['Triage Customer Bug Tickets', '分类客户 Bug 工单'],
		['Investigate Alerts Triggered', '调查触发的告警'],
		['Fix Sentry Errors Daily', '每天修复 Sentry 错误'],
		['Daily Error Report', '每日错误报告'],
		['Trigger event', '触发事件'],
		['File report', '文件报告'],

		// ========== Review 语言对话框 ==========
		['What language should Devin\'s review comments use?', 'Devin 的审查评论应使用什么语言？'],
		['Choose the language Devin uses for review comments.', '选择 Devin 用于审查评论的语言。'],
		['Search languages...', '搜索语言...'],
		['Use your display language', '使用你的显示语言'],
		['Reviews follow your account\'s display language', '审查遵循你账户的显示语言'],
		['English', '英语'],
		['Arabic', '阿拉伯语'],
		['Chinese', '中文'],
		['Edit in settings', '在设置中编辑'],
		['Done', '完成'],

		// ========== 会话列表 / 底部栏 ==========
		['Tip: Search your sessions (Ctrl+Shift+A)', '提示：搜索你的会话 (Ctrl+Shift+A)'],
		['Tip: New space (Ctrl+N)', '提示：新建空间 (Ctrl+N)'],
		['Go to sessions list', '转到会话列表'],
		['Recent sessions', '最近的会话'],
		['Projects', '项目'],
		['Local', '本地'],
		['Worktree', '工作树'],
		['Cloud', '云'],
		['Connect to SSH host...', '连接到 SSH 主机...'],
		['Devin Cloud', 'Devin 云'],
		['to switch agents', '切换智能体'],

		// ========== Customizations / MCP ==========
		['Customizations', '自定义'],
		['Plugins', '插件'],
		['Hooks', 'Hooks'],
		['Subagents', '子智能体'],
		['No MCP servers installed.', '未安装 MCP 服务器。'],
		['Add custom MCP', '添加自定义 MCP'],
		['Browse and install MCP servers for Devin', '浏览并为 Devin 安装 MCP 服务器'],
		['MCP servers configured for Devin Local.', '为 Devin 本地配置的 MCP 服务器。'],

		// ========== Codemaps ==========
		['Enter a starting point for a new codemap', '输入新代码地图的起点'],
		['Suggestions', '推荐'],
		['No suggestions found', '未找到推荐'],

		// ========== 远程资源管理器 ==========
		['Dev Containers', 'Dev 容器'],
		['WSL Targets', 'WSL 目标'],
		['Ubuntu default distro', 'Ubuntu 默认发行版'],

		// ========== Usage / Plan ==========
		['Usage', '使用量'],
		['Quota resets daily/weekly.', '配额每日/每周重置。'],
		['Daily quota usage', '每日配额使用'],
		['Weekly quota usage', '每周配额使用'],
		['Extra usage balance', '额外使用余额'],
		['Purchase extra usage', '购买额外使用量'],
		// ========== MCP Registry 页面 ==========
		['MCP Registry', 'MCP 注册表'],
		['Installed', '已安装'],
		['Available', '可用'],
		// 'tools' 不做静态翻译，避免误翻文件夹名；动态 "N tools" 已由 REGEX_TRANSLATIONS 覆盖
		['Enabled', '已启用'],
		['Error', '错误'],
		['No tools found.', '未找到工具。'],
		['Quota resets daily/weekly.', '配额每日/每周重置。'],
		['Purchase extra usage or manage auto refill', '购买额外使用量或管理自动充值'],

		// ========== Plan Info 页面（截图1） ==========
		['Daily quota usage:', '每日配额使用:'],
		['Weekly quota usage:', '每周配额使用:'],
		['Extra usage balance:', '额外使用余额:'],
		['Resets', '重置于'],
		['Plan ends in', '套餐将在'],
		['days', '天后到期'],

		// ========== Devin Terminal 描述（截图2） ==========
		['These settings only apply to Devin for Terminal and are saved to', '这些设置仅适用于 Devin 终端，并保存到'],

		// ========== Windsurf Tab 描述带句号版（截图3） ==========
		['When enabled, Windsurf will use the clipboard as context for completions.', '启用后，Windsurf 将使用剪贴板内容作为补全的上下文。'],
		['Quickly add and update imports with a tab keypress.', '按 Tab 快速添加和更新导入语句。'],
		['Predict the location of your next edit and navigates you there with a tab keypress.', '预测下一个编辑位置，按 Tab 跳转到该位置。'],
		['Controls how proactively Supercomplete suggests edits near your cursor.', '控制 Supercomplete 在光标附近主动建议编辑的频率。'],
		['Choose your preferred code completion experience.', '选择你偏好的代码补全体验。'],

		// ========== Agents 页面（截图4） ==========
		['No environment variables set.', '未设置环境变量。'],
		['Add', '添加'],

		// ========== 模型选择器分组菜单 ==========
		['Provider', '提供商'],
		['Input cost', '输入成本'],
		['Cached input cost', '缓存输入成本'],
		['Output cost', '输出成本'],
		['All models draw from your Devin ACU balance', '所有模型从你的 Devin ACU 余额中扣费'],

		// ========== 底部栏 ==========
		['Reject all', '全部拒绝'],
		['Accept all', '全部接受'],
		['Windsurf - Settings', 'Windsurf - 设置'],
		['Ask anything', '询问任何问题'],

		// ========== Cascade 状态文本 ==========
		['Surfing..', '驰骋中..'],
		['Surfing.', '驰骋中.'],
		['Exploring..', '探索中..'],
		['Exploring.', '探索中.'],
		['Floating..', '酝酿中..'],
		['Floating.', '酝酿中.'],
		['Thinking..', '思考中..'],
		['Thinking.', '思考中.'],
		['Generating..', '生成中..'],
		['Generating.', '生成中.'],
		['Sailing..', '航行中..'],
		['Sailing.', '航行中.'],

		// ========== 输入框/模式切换 ==========
		['Switch mode', '切换模式'],
		['Search settings', '搜索设置'],
		['+ Add', '+ 添加'],

		// ========== Skills 页面 ==========
		['Skills are rules or workflows with additional resources that the model can choose to invoke.', '技能是模型可以选择调用的规则或工作流，包含额外资源。'],
		['resources', '个资源'],

		// ========== 发送按钮菜单 ==========
		['Queue', '排队发送'],
		['Send now', '立即发送'],

		// ========== 顶栏按钮 tooltip ==========
		['Past Conversations', '历史对话'],
		['Start a New Conversation', '开始新对话'],
		['Start recording', '开始录音'],
		['Add Context', '添加上下文'],
		['Model Selector', '模型选择'],
		['Conversation', '对话'],

		// ========== 欢迎页 ==========
		['Start', '开始'],
		['Generate a New Project', '创建新项目'],
		['Clone Repository', '克隆仓库'],
		['Connect via SSH', '通过 SSH 连接'],
		['Recent Projects', '最近的项目'],
		['Show More...', '显示更多...'],

		// ========== 会话管理页面 ==========
		['All sessions', '所有会话'],
		['New session', '新建会话'],
		['Spaces', '空间'],
		['Running', '运行中'],
		['Blocked', '已阻塞'],
		['Uncategorized', '未分类'],
		['Search sessions...', '搜索会话...'],
		['Search sessions', '搜索会话'],
		['Last 24 hours', '最近 24 小时'],
		['Include archived', '包含已归档'],
		['Rename', '重命名'],
		['Archive', '归档'],
		['Unarchive', '取消归档'],
		['Last run', '上次运行'],
		['files', '个文件'],
		['cascade', 'cascade'],

		// ========== 文件变更区域 ==========
		['files with changes', '个文件有变更'],
		['View all', '查看全部'],
		['View all changes', '查看所有变更'],
		['MCP servers', 'MCP 服务器'],

		// ========== 会话筛选 ==========
		['Exclude archived', '排除已归档'],
		['Only archived', '仅已归档'],
		['Unassigned', '未分配'],
		['Time is', '时间为'],
		['just now', '刚刚'],

		// ========== 上下文/缓存状态 ==========
		['context used', '上下文已用'],
		['Prompt cache expires in', '提示缓存过期于'],
		['Send', '发送'],
		['message queued', '条消息排队中'],
		['1 message queued', '1 条消息排队中'],
		['2 messages queued', '2 条消息排队中'],
		['3 messages queued', '3 条消息排队中'],
		['Message with attachments', '带附件的消息'],
		['Enter to send queued message', '按回车发送排队消息'],
		['Queued messages will be sent one at a time. Click to send this message now.', '排队消息将逐条发送。点击可立即发送此消息。'],
		['Queued messages will be sent one at a time. Press', '排队消息将逐条发送。按'],
		['or click here to send the first queued message.', '或点击此处发送第一条排队消息。'],
		['messages queued', '条消息排队中'],

		// ========== 排队消息操作 ==========
		['Edit message', '编辑消息'],
		['Remove from queue', '从队列移除'],

		// ========== 终端命令相关 ==========
		['Command Auto-ran', '命令已自动运行'],
		['Copy command', '复制命令'],
		['Moves this terminal session to the Terminal tab in your IDE. Cascade will still be able to use it.', '将此终端会话移至 IDE 的终端标签页。Cascade 仍可使用它。'],
		['Review', '审查'],
		// ========== 欢迎页快捷键 ==========
		['Cascade in new tab', '在新标签页中打开 Cascade'],
		// ========== 远程连接菜单 ==========
		['Connect to SSH Host...', '连接到 SSH 主机...'],
		['Connect to SSH Host in Current Window...', '在当前窗口连接到 SSH 主机...'],
		['Open Folder in Container', '在容器中打开文件夹'],
		['Attach to Running Container', '附加到运行中的容器'],
		['Reopen in Container', '在容器中重新打开'],
		['Connect to WSL', '连接到 WSL'],
		['Connect to WSL using Distro...', '使用发行版连接到 WSL...'],

		// ========== Cascade 对话区域 ==========
		['Thoughts', '思考过程'],
		['Analyzed', '已分析'],
		['tasks done', '个任务完成'],
		['more', '更多'],
		['Read', '读取'],

		// ========== 配额提示条 ==========
		['You\'ve used', '已使用'],
		['of your quota', '的配额'],
		['Quota resets', '配额重置于'],
		['Promo pricing is active for a limited time', '限时促销价生效中'],
		['tokens', 'tokens'],
		['Fast', '快速'],
		['Connecting to server...', '正在连接服务器...'],
		['Your included daily usage quota is exhausted.', '您的每日配额已用完。'],
		['Your included usage quota is exhausted.', '您的配额已用完。'],
		['to continue using premium models.', '以继续使用高级模型。'],
		['Purchase additional usage', '购买额外使用量'],

		// ========== Codemaps ==========
		['Codemaps', '代码地图'],
		['Suggestions from recent activity', '根据最近活动推荐'],
		['Your Codemaps', '你的代码地图'],
		['Search', '搜索'],
		['No codemaps found for this repository.', '此仓库未找到代码地图。'],
		['Show Archived Codemaps', '显示已归档的代码地图'],
		['Only Starred Codemaps', '仅显示星标代码地图'],
		['from recent activity', '根据最近活动'],

		// ========== 设置菜单 ==========
		['Windsurf Settings', 'Windsurf 设置'],
		['Windsurf Usage', 'Windsurf 用量'],
		['Quick Settings Panel', '快捷设置面板'],
		['Windsurf Account', 'Windsurf 账户'],
		['Docs', '文档'],
		['Join the Community', '加入社区'],
		['Changelog', '更新日志'],
		['Current Workspace', '当前工作区'],
		['now', '刚刚'],

		// ========== 文件编辑操作 ==========
		['edits', '处编辑'],
		['Accept File', '接受文件'],
		['Reject File', '拒绝文件'],

		// ========== 终端操作 ==========
		['Send Terminal to Chat', '发送终端到聊天'],
		['Send to Chat', '发送到聊天'],

		// ========== 回复操作按钮 ==========
		['Copy response', '复制回复'],
		['Create a Codemap', '创建代码地图'],
		['View response statistics', '查看回复统计'],
		['Other actions', '更多操作'],

		// ========== Web 请求弹窗 ==========
		['Allow web request?', '允许 Web 请求？'],
		['Cascade wants to fetch this URL', 'Cascade 想要访问此 URL'],
		['Allow Once', '允许一次'],
		['Always allow this page', '始终允许此页面'],
		['Allow all requests', '允许所有请求'],

		// ========== 回复截断 ==========
		['Cascade\'s response was cut short due to length limits.', 'Cascade 的回复因长度限制被截断。'],
		['Continue to generate the full response. This will consume the selected model\'s cost.', '继续生成完整回复。这将消耗所选模型的额度。'],
		['Continue response', '继续回复'],

		// ========== 预览/命令状态 ==========
		['Checked command status', '已检查命令状态'],
		['Running Preview:', '运行预览:'],
		['Open website preview in:', '在以下位置打开网站预览:'],
		['System Browser', '系统浏览器'],
		['In-IDE', 'IDE 内'],
		['BETA', 'BETA'],

		// ========== 超时/重试 ==========
		['This is taking a long time. Click to retry if it seems stuck.', '响应时间较长。如果卡住了，点击重试。'],
		['Surfing.', '冲浪中…'],

		// ========== 允许/禁止列表 ==========
		['Hide Allow/Deny list', '隐藏允许/禁止列表'],
		['Show Allow/Deny list', '显示允许/禁止列表'],
		['Allow / Deny List', '允许 / 禁止列表'],
		['Allow List', '允许列表'],
		['Deny List', '禁止列表'],
		['If terminal command auto-execution is enabled, Cascade will auto-run commands in the allowlist and ask for permission for commands in the denylist, with the denylist taking precedence.', '当终端命令自动执行开启时，Cascade 会自动运行允许列表中的命令，并对禁止列表中的命令请求权限，禁止列表优先。'],
		['If terminal command auto-execution is disabled, Cascade will ask for permission for all commands.', '当终端命令自动执行关闭时，Cascade 会对所有命令请求权限。'],
		['Add " *" at the end of a command for prefix matching (e.g., "git *" matches all git commands).', '在命令末尾添加 " *" 进行前缀匹配（例如 "git *" 匹配所有 git 命令）。'],
		// ========== Settings 左侧菜单补充 ==========
		['Plan information', '套餐信息'],
		['Extensions', '扩展'],
		['Devin Local', 'Devin 本地'],
		['User interface', '用户界面'],
		['Devin Tab', 'Devin Tab'],

		// ========== Devin Tab 设置页 ==========
		['Auto-continue', '自动继续'],
		['Auto-fix lints', '自动修复 Lint'],
		['Enable Fast Context', '启用快速上下文'],
		['Gitignore access', 'Gitignore 访问权限'],
		['Clipboard context', '剪贴板上下文'],
		['Completion mode', '补全模式'],
		['Tab to import', 'Tab 导入'],
		['Tab to jump', 'Tab 跳转'],
		['Share terminal activity', '共享终端活动'],
		['Share user edits', '共享用户编辑'],
		['Agent Command Center location', '智能体命令中心位置'],
		['Agent notifications', '智能体通知'],
		['Remote agent hosts', '远程智能体主机'],
		['Connect on startup', '启动时连接'],
		['Model provider API keys', '模型提供商 API 密钥'],
		['Anthropic API key', 'Anthropic API 密钥'],

		// ========== Extensions 页面 ==========
		['General editor preferences open in a separate page', '通用编辑器首选项在单独页面打开'],
		['Current plan', '当前套餐'],

		// ========== Security 页面 ==========
		['Scans', '扫描'],
		['Profiles', '配置文件'],
		['No scans yet', '暂无扫描'],
		['Start a scan to search for findings across your repositories.', '开始扫描以搜索仓库中的问题。'],
		['Start scan', '开始扫描'],

		// ========== Automations 页面 ==========
		['Introducing Automations', '介绍自动化'],
		['Trigger on events or schedules to investigate issues, generate insights, and create pull requests automatically.', '基于事件或计划触发，自动调查问题、生成洞察并创建拉取请求。'],
		['Key features', '主要功能'],
		['Event-based triggers', '基于事件的触发器'],
		['Automatically run Devin from supported integrations or your own systems using custom webhooks', '从支持的集成或您自己的系统使用自定义 Webhook 自动运行 Devin'],
		['Scheduled triggers', '计划触发器'],
		['Have Devin handle workloads on any recurring date or time interval', '让 Devin 在任意循环日期或时间间隔处理工作负载'],
		['Persistent Memory', '持久记忆'],
		['Use scratchpad to persist state and knowledge across automation runs', '使用暂存区在自动化运行之间持久保存状态和知识'],
		['Bring Devin into your recurring and event-driven workflows', '将 Devin 引入您的循环和事件驱动工作流'],
		['Mine', '我的'],
		['All', '全部'],
		['Create automation', '创建自动化'],
		['Generate with Devin', '用 Devin 生成'],
		['Describe what automation you want to build', '描述您想构建的自动化'],
		['Create manually', '手动创建'],
		['Configure automation triggers, actions, and limits yourself', '自己配置自动化触发器、操作和限制'],
		['Create from template', '从模板创建'],
		['Customize a preset automation to fit your needs', '自定义预设自动化以满足您的需求'],
		['Suggested automations', '推荐的自动化'],
		['Monitoring & Triage', '监控和分类'],
		['CI/CD & Release', 'CI/CD 和发布'],
		['Project Management', '项目管理'],

		// ========== Devin Desktop 设置页 ==========
		['Devin Desktop', 'Devin 桌面版'],
		['Manage your Devin Desktop API keys and privacy settings.', '管理您的 Devin 桌面版 API 密钥和隐私设置。'],
		['Account activity', '账户活动'],
		['View account activity on windsurf.com', '在 windsurf.com 查看账户活动'],
		['View usage', '查看使用量'],
		['Models', '模型'],
		['Configure which AI models are available and how they\'re used', '配置哪些 AI 模型可用以及如何使用'],
		['Enable access to OpenAI models with data retention', '启用对具有数据保留的 OpenAI 模型的访问'],
		['Unlocks additional OpenAI models that require data retention for trust and safety verification.', '解锁需要数据保留以进行信任和安全验证的其他 OpenAI 模型。'],
		['OpenAI stores this data for up to 30 days and does not use it for model training or improvement. This setting applies only to OpenAI models.', 'OpenAI 最多存储此数据 30 天，不会将其用于模型训练或改进。此设置仅适用于 OpenAI 模型。'],
		['Shared conversations', '共享对话'],
		['Beta', '测试版'],
		['Manage Devin Local sessions you\'ve shared', '管理您共享的 Devin Local 会话'],
		['Source', '来源'],
		['No shared conversations', '暂无共享对话'],
		['Conversations you share from Devin Local will appear here.', '您从 Devin Local 共享的对话将显示在此处。'],
		['Shared codemaps', '共享代码地图'],
		['Manage codemaps you\'ve shared from Devin Desktop', '管理您从 Devin 桌面版共享的代码地图'],
		['Created at', '创建时间'],
		['No shared codemaps', '暂无共享代码地图'],
		['Codemaps you share from Devin Desktop will appear here.', '您从 Devin 桌面版共享的代码地图将显示在此处。'],
		['Team shared codemaps', '团队共享代码地图'],
		['Codemaps shared with your team by other members', '其他成员与团队共享的代码地图'],
		['Owner', '所有者'],
		['No team codemaps', '暂无团队代码地图'],
		['Codemaps shared with your team will appear here.', '与团队共享的代码地图将显示在此处。'],
		['Your Anthropic API key will be used to power Claude models in Devin Desktop. You can manage your API keys in the Anthropic console.', '您的 Anthropic API 密钥将用于驱动 Devin 桌面版中的 Claude 模型。您可以在 Anthropic 控制台中管理 API 密钥。'],

		// ========== 底部状态栏 / 会话列表 ==========
		['Go to sessions list', '转到会话列表'],
		['Recent sessions', '最近的会话'],
		['Local', '本地'],
		['Worktree', '工作树'],
		['Cloud', '云'],
		['Connect to SSH host...', '连接到 SSH 主机...'],
		['Tip: Search your sessions (Ctrl+Shift+A)', '提示：搜索您的会话 (Ctrl+Shift+A)'],
		['Devin Cloud', 'Devin 云'],
		['使用 Ctrl \' to switch agents', '使用 Ctrl \' 切换智能体'],

		// ========== Review 语言选择对话框 ==========
		['What language should Devin\'s review comments use?', 'Devin 的审查评论应使用什么语言？'],
		['Choose the language Devin uses for review comments.', '选择 Devin 用于审查评论的语言。'],
		['Search languages...', '搜索语言...'],
		['Use your display language', '使用您的显示语言'],
		['Reviews follow your account\'s display language', '审查遵循您账户的显示语言'],
		['English', '英语'],
		['Arabic', '阿拉伯语'],
		['Chinese', '中文'],
		['Edit in settings', '在设置中编辑'],
		['Done', '完成'],
		// ========== DeepWiki ==========
		['DeepWiki', 'DeepWiki'],
		['Welcome to DeepWiki', '欢迎使用 DeepWiki'],
		['Right-click on a symbol and select', '右键点击符号并选择'],
		['"See Wiki"', '"查看 Wiki"'],
		['to explore its definition, usage, and documentation.', '以查看其定义、用法和文档。'],
		// ========== 快捷键 / 高级页面 ==========
		['View all Devin shortcuts', '查看所有 Devin 快捷键'],
		['Detect proxy', '检测代理'],
		['Automatically detect a network proxy. Changing this reloads Devin', '自动检测网络代理。更改此项会重新加载 Devin'],
		['Ctrl+I to generate a command.', 'Ctrl+I 生成命令。'],

		// ========== 命令面板 / 侧边栏 ==========
		['Start a new session in this space', '在此空间开始新会话'],
		['Open file', '打开文件'],
		['Open a file from the workspace', '从工作区打开文件'],
		['Open customizations', '打开自定义'],
		['Manage rules, skills, MCPs and plugins', '管理规则、技能、MCP 和插件'],
		['View diffs', '查看差异'],
		['No changes available yet', '暂无可用更改'],

		// ========== Remote agent hosts 页 ==========
		['Connect to agents on remote machines over SSH.', '通过 SSH 连接到远程机器上的智能体。'],
		['Connect to saved hosts automatically on startup.', '启动时自动连接已保存的主机。'],

		// ========== Review 语言对话框（完整） ==========
		['What language should Devin\'s review comments use?', 'Devin 的审查评论应使用什么语言？'],
		['Choose the language Devin uses for review comments.', '选择 Devin 用于审查评论的语言。'],
		['Search languages...', '搜索语言...'],
		['Use your display language', '使用你的显示语言'],
		['Reviews follow your account\'s display language', '审查遵循你账户的显示语言'],
		['English', '英语'],
		['Arabic', '阿拉伯语'],
		['Chinese', '中文'],
		['Edit in settings', '在设置中编辑'],
		['Back', '返回'],
		['Done', '完成'],

		// ========== Automations 页面 ==========
		['Bring Devin into your recurring and event-driven workflows', '将 Devin 引入你的循环和事件驱动工作流'],
		['Create automation', '创建自动化'],
		['Generate with Devin', '用 Devin 生成'],
		['Describe what automation you want to build', '描述你想构建的自动化'],
		['Create manually', '手动创建'],
		['Configure automation triggers, actions, and limits yourself', '自己配置自动化触发器、操作和限制'],
		['Create from template', '从模板创建'],
		['Customize a preset automation to fit your needs', '自定义预设自动化以满足你的需求'],
		['Suggested automations', '推荐的自动化'],
		['Monitoring & Triage', '监控和分类'],
		['CI/CD & Release', 'CI/CD 和发布'],
		['Project Management', '项目管理'],
		['Triage Bug Reports', '分类 Bug 报告'],
		['Triage Support Requests', '分类支持请求'],
		['Investigate Alerts Triggered', '调查触发的告警'],
		['Fix Sentry Errors Daily', '每天修复 Sentry 错误'],
		['Daily Error Report', '每日错误报告'],

		// ========== Security 页面 ==========
		['Start scan', '开始扫描'],
		['No scans yet', '暂无扫描'],
		['Start a scan to search for findings across your repositories.', '开始扫描以搜索仓库中的问题。'],

		// ========== Repositories 页面 ==========
		['Search repositories', '搜索仓库'],
		['Repositories', '仓库'],
		['No repositories found', '未找到仓库'],
		['Connect a Git provider to see your repositories here.', '连接 Git 提供商以在此查看你的仓库。'],
// ========== 输入框菜单 ==========
		['Upload file', '上传文件'],
		['Files', '文件'],
		['Directories', '目录'],
		['Conversations', '对话'],
		['Git', 'Git'],
		['Slash commands', '斜杠命令'],
		// ========== 设置页标题（大小写变体） ==========
		["Show explain problem inlay hint", "显示问题解释内联提示"],
		["Show inlay shortcuts", "显示内联快捷键"],
		["Show selection popup", "显示选区弹窗"],
		["Scroll to next diff on accept", "接受时滚动到下一个差异"],
		["Agent diff zones", "Agent 差异区域"],
		["Show interactive diff zones with accept/reject controls for agent file edits", "显示交互式差异区域，包含接受/拒绝控件，用于 Agent 文件编辑"],
		
		// ========== 输入框提示 ==========
		["Tip: Try typing \"megaplan\" to plan deeply before building", "提示：尝试输入 \"megaplan\" 在构建前深入规划"],
		["Tip: Type @ conversation to bring in context from another chat", "提示：输入 @ 对话以引入其他聊天的上下文"],
		// ========== 模式切换菜单 ==========
		['Write and edit code', '编写和编辑代码'],
		['Smart', '智能'],
		['Auto-approve actions the model judges safe', '自动批准模型认为安全的操作'],
		['Answer questions without code changes', '回答问题但不修改代码'],
		['Auto-approve all tool calls', '自动批准所有工具调用'],
		['Bypass Permissions', '绕过权限'],
		// ========== 状态栏 / 远程资源管理器 ==========
		["Free - Upgrade Now", "免费 - 立即升级"],
		["Devin - Settings", "Devin - 设置"],
		["Upgrade Now", "立即升级"],
		["Dev Containers (Devin Desktop)", "Dev 容器 (Devin 桌面版)"],
		["SSH (Devin)", "SSH (Devin)"],
		["WSL Targets (Devin Desktop)", "WSL 目标 (Devin 桌面版)"],
		["Ubuntu default distro", "Ubuntu 默认发行版"],
		["Using Open VSX mirror", "正在使用 Open VSX 镜像"],
		["(change here).", "（点此更改）。"],
		["Enter a starting point for a new codemap", "输入新代码地图的起点"],
		["Describe your task to Devin", "向 Devin 描述你的任务"],
		["Tip: Type @ conversation to bring in context from another chat", "提示：输入 @ 对话以引入其他聊天的上下文"],
		["Open Codex Sidebar", "打开 Codex 侧边栏"],
		["Devin Settings", "Devin 设置"],
		// ========== 底部切换 ==========
		['Switch agent (Ctrl+\')', '切换智能体 (Ctrl+\')'],
		// ========== Devin Desktop 设置页 ==========
		['Devin Desktop', 'Devin 桌面版'],
		['Manage your Devin Desktop API keys and privacy settings.', '管理你的 Devin 桌面版 API 密钥和隐私设置。'],
		['Usage', '使用量'],
		['Account activity', '账户活动'],
		['View account activity on windsurf.com', '在 windsurf.com 查看账户活动'],
		['View usage', '查看使用量'],
		['Models', '模型'],
		['Configure which AI models are available and how they\'re used', '配置哪些 AI 模型可用以及如何使用'],
		['Enable access to OpenAI models with data retention', '启用对具有数据保留的 OpenAI 模型的访问'],
		['Unlocks additional OpenAI models that require data retention for trust and safety verification.', '解锁需要数据保留以进行信任和安全验证的其他 OpenAI 模型。'],
		['OpenAI stores this data for up to 30 days and does not use it for model training or improvement. This setting applies only to OpenAI models.', 'OpenAI 最多存储此数据 30 天，不会用于模型训练或改进。此设置仅适用于 OpenAI 模型。'],
		['Shared conversations', '共享对话'],
		['Beta', '测试版'],
		['Manage Devin Local sessions you\'ve shared', '管理你共享的 Devin 本地会话'],
		['Source', '来源'],
		['No shared conversations', '暂无共享对话'],
		['Conversations you share from Devin Local will appear here.', '你从 Devin 本地共享的对话将显示在此处。'],
		['Shared codemaps', '共享代码地图'],
		['Manage codemaps you\'ve shared from Devin Desktop', '管理你从 Devin 桌面版共享的代码地图'],
		['Created at', '创建时间'],
		['No shared codemaps', '暂无共享代码地图'],
		['Codemaps you share from Devin Desktop will appear here.', '你从 Devin 桌面版共享的代码地图将显示在此处。'],
		['Team shared codemaps', '团队共享代码地图'],
		['Codemaps shared with your team by other members', '其他成员与团队共享的代码地图'],
		['Owner', '所有者'],
		['No team codemaps', '暂无团队代码地图'],
		['Codemaps shared with your team will appear here.', '与团队共享的代码地图将显示在此处。'],
		['Model provider API keys', '模型提供商 API 密钥'],
		['Anthropic API key', 'Anthropic API 密钥'],
		['Your Anthropic API key will be used to power Claude models in Devin Desktop. You can manage your API keys in the Anthropic console.', '你的 Anthropic API 密钥将用于驱动 Devin 桌面版中的 Claude 模型。你可以在 Anthropic 控制台中管理 API 密钥。'],
		['Save', '保存'],
	]);
			
	const REGEX_TRANSLATIONS = [
		[/^Scans\s+(\d+)$/i, '扫描 $1'],
		[/^Profiles\s+(\d+)$/i, '配置文件 $1'],
		[/^Automations\s+(\d+)$/i, '自动化 $1'],
		[/^Mine\s+(\d+)$/i, '我的 $1'],
		[/^All\s+(\d+)$/i, '全部 $1'],
		[/^(\d+)%\s*used$/i, '已用 $1%'],
		[/^Resets\s+(.+)$/i, '重置于 $1'],
		[/^(\d+)\s+MCP\s+servers?$/i, '$1 个 MCP 服务器'],
		[/^(\d+)\s+scans?$/i, '$1 次扫描'],
		[/^(\d+)\s+profiles?$/i, '$1 个配置文件'],
		[/^(\d+)\s+automations?$/i, '$1 个自动化'],
		[/^for\s+(\d+)s$/i, '耗时 $1 秒'],
		[/^(\d+)\s+tasks$/i, '$1 个任务'],
		[/^(\d+)\s+chunks$/i, '$1 个分片'],
		[/^Failed to fetch document content at$/i, '无法获取文档内容：'],
		[/^Quota resets daily\/weekly\.\s*Plan ends in (\d+) days$/i, '配额每日/每周重置。套餐将在 $1 天后到期'],
		[/^Quota resets daily\/weekly$/i, '配额每日/每周重置'],
		[/^Plan ends in (\d+) days\s*\((.+)\)$/i, '套餐将在 $1 天后到期 ($2)'],
		[/^These settings only apply to Devin for Terminal and are saved to\s*(.+)$/i, '这些设置仅适用于 Devin 终端，并保存到 $1'],
		[/^Resets\s+(.+)$/i, '重置于 $1'],
		[/^(\d+)K context$/i, '$1K 上下文'],
		[/^\$([0-9.]+)\s*\/\s*1M tokens$/i, '$$$1 / 百万 tokens'],
		[/^Plan ends in (\d+) days$/i, '套餐将在 $1 天后到期'],
		[/^(\d+)\s+tools$/i, '$1 个工具'],
		[/^(\d+)\s*\/\s*(\d+)\s+tools$/i, '$1 / $2 个工具'],
		[/^Switch mode\s*\((.+)\)$/i, '切换模式 ($1)'],
		[/^Queue\s*\((.+)\)$/i, '排队发送 ($1)'],
		[/^Send now\s*\((.+)\)$/i, '立即发送 ($1)'],
		[/^Send now\s+(.+)$/i, '立即发送 $1'],
		[/^Ask anything\s*\((.+)\)$/i, '询问任何问题 ($1)'],
		[/^(\d+)\s+resources$/i, '$1 个资源'],
		[/^Start a New Conversation\s+(.+)$/i, '开始新对话 $1'],
		[/^Start recording\s*\((.+)\)$/i, '开始录音 ($1)'],
		[/^Add Context\s*\((.+)\)$/i, '添加上下文 ($1)'],
		[/^Model Selector\s*\((.+)\)$/i, '模型选择 ($1)'],
		[/^Past Conversations\s*\((.+)\)$/i, '历史对话 ($1)'],
		[/^Search all models\s*\((.+)\)$/i, '搜索所有模型 ($1)'],
		[/^(\d+)m ago$/i, '$1 分钟前'],
		[/^(\d+)h ago$/i, '$1 小时前'],
		[/^(\d+)d ago$/i, '$1 天前'],
		[/^(\d+)s ago$/i, '$1 秒前'],
		[/^(\d+)\s+files$/i, '$1 个文件'],
		[/^(\d+)\s+MCP servers?$/i, '$1 个 MCP 服务器'],
		[/^Rename\s+(\d+)\s+files?\s+(\d+)$/i, '重命名 $1 个文件 $2'],
		[/^Daily:\s*(\d+)%\s*quota used\s*[·\-]\s*Weekly:\s*(\d+)%\s*quota used$/i, '日配额已用 $1% · 周配额已用 $2%'],
		[/^Daily:\s*(\d+)%\s*quota used$/i, '日配额已用 $1%'],
		[/^Weekly:\s*(\d+)%\s*quota used$/i, '周配额已用 $1%'],
		[/^(\d+)%\s*quota used$/i, '配额已用 $1%'],
		[/^(\d+)\s+files with changes$/i, '$1 个文件有变更'],
		[/^(\d+)\s+files?\s+(\+\d+)\s+(-\d+)$/i, '$1 个文件 $2 $3'],
		[/^(\d+)%\s*\(([^)]+)\)\s*context used$/i, '$1% ($2) 上下文已用'],
		[/^Prompt cache expires in\s+(.+)$/i, '提示缓存 $1 后过期'],
		[/^Send\s*\((.+)\)$/i, '发送 ($1)'],
		[/^(\d+)\s+messages?\s+queued$/i, '$1 条消息排队中'],
		[/^Enter to send queued message\s*\((.+)\)$/i, '按回车发送排队消息 ($1)'],
		[/^(\d+)\s*\/\s*(\d+)\s+tasks?\s+done$/i, '$1 / $2 个任务完成'],
		[/^(\d+)\s+tasks?\s+done$/i, '$1 个任务完成'],
		[/^(\d+)\s+more$/i, '还有 $1 项'],
		[/^Analyzed\s+(.+)$/i, '已分析 $1'],
		[/^Read\s+(.+)$/i, '读取 $1'],
		[/^You['\u2019]ve used\s+(\d+)%\s+of your quota\.?\s*Quota resets\s+(.+)$/i, '已使用 $1% 的配额。配额重置于 $2'],
		[/^You['\u2019]ve used\s+(\d+)%\s+of your quota$/i, '已使用 $1% 的配额'],
		[/^Quota resets\s+(.+)$/i, '配额重置于 $1'],
		[/^Your included daily usage quota is exhausted\.\s*(.+?)\s+to continue using premium models\.\s*(.+)$/i, '您的每日配额已用完。$1以继续使用高级模型。$2'],
		[/^Enter a starting point for a new codemap\s*\((.+)\)$/i, '输入新代码地图的起点 ($1)'],
		[/^Enter a starting point for a new codemap$/i, '输入新代码地图的起点'],
		[/^Windsurf Account\s*\((.+)\)$/i, 'Windsurf 账户 ($1)'],
		[/^(\d+)\s+edits?$/i, '$1 处编辑'],
		[/^Accept File\s+(.+)$/i, '接受文件 $1'],
		[/^Reject File\s+(.+)$/i, '拒绝文件 $1'],
		[/^Send Terminal to Chat\s*\((.+)\)$/i, '发送终端到聊天 ($1)'],
		[/^Cancel\s*\((.+)\)$/i, '取消 ($1)'],
		[/^Prompt cache expires in\s+(\d+:\d+)$/i, '提示缓存过期于 $1'],
		[/^Invalid argument:\s*an internal error occurred\s*\(trace ID:\s*([a-f0-9]+)\)$/i, '参数无效：发生内部错误（跟踪 ID：$1）'],
	];
	
	function logLocalization(...args) { console.log(LOG_PREFIX + '[Localization]', ...args); }
	
	function translateText(text) {
		if (!text || !text.trim()) return text;
		const leading = text.match(/^\s*/)?.[0] ?? '';
		const trailing = text.match(/\s*$/)?.[0] ?? '';
		const core = text.trim();
		
		if (TRANSLATIONS.has(core)) {
			return `${leading}${TRANSLATIONS.get(core)}${trailing}`;
		}
		
		for (const [pattern, replacement] of REGEX_TRANSLATIONS) {
			if (pattern.test(core)) {
				return `${leading}${core.replace(pattern, replacement)}${trailing}`;
			}
		}
		return text;
	}
	
	function shouldSkip(node) {
		if (!node) return true;
		if (node.nodeType === Node.ELEMENT_NODE) {
			return Boolean(node.closest(EXCLUDE_SELECTOR));
		}
		const parent = node.parentElement;
		return !parent || Boolean(parent.closest(EXCLUDE_SELECTOR));
	}
	
	function translateAttributes(el) {
		if (!el || shouldSkip(el)) return;
		for (const attr of ATTRS_TO_TRANSLATE) {
			const value = el.getAttribute(attr);
			if (!value) continue;
			const translated = translateText(value);
			if (translated !== value) {
				el.setAttribute(attr, translated);
			}
		}
	}
	
	function translateTextNode(node) {
		if (!node || shouldSkip(node)) return;
		const original = node.nodeValue;
		const translated = translateText(original);
		if (translated !== original) {
			node.nodeValue = translated;
		}
	}
	
	function scanAndTranslate(root) {
		if (!root || !settings.localizationEnabled) return;
		if (root.nodeType === Node.TEXT_NODE) {
			translateTextNode(root);
			return;
		}
		
		const elementRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
		if (!elementRoot) return;
		
		translateAttributes(elementRoot);
		// 仅遍历含可翻译属性的元素，而非全部元素
		const attrSelector = ATTRS_TO_TRANSLATE.map(a => '[' + a + ']').join(',');
		if (attrSelector) {
			const attrElements = elementRoot.querySelectorAll(attrSelector);
			for (const el of attrElements) {
				translateAttributes(el);
			}
		}
		
		const walker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_TEXT);
		let current = walker.nextNode();
		while (current) {
			translateTextNode(current);
			current = walker.nextNode();
		}
	}
	
	let pendingRoots = new Set();
	let rafId = 0;
	let _isTranslating = false; // 防止翻译触发mutation→无限循环

	function flushQueue() {
		rafId = 0;
		if (!settings.localizationEnabled) { pendingRoots.clear(); return; }
		_isTranslating = true;
		for (const root of pendingRoots) {
			scanAndTranslate(root);
		}
		pendingRoots.clear();
		// 延迟重置标志，让mutation回调中的_isTranslating仍为true以跳过
		setTimeout(() => { _isTranslating = false; }, 0);
	}

	function enqueue(root) {
		if (_isTranslating) return; // 翻译自身触发的mutation，跳过
		pendingRoots.add(root || document.body);
		if (!rafId) {
			rafId = requestAnimationFrame(flushQueue);
		}
	}

	function startLocalizationObserver() {
		// 已由统一观察器接管，此处仅做初始化翻译
		enqueue(document.body);
	}
	
	// ========== 设置面板已迁移到Extension侧边栏 ==========
	// 设置面板UI不再在workbench.html中创建，由windsurf-better-extension提供

	
	// ========== 统一 MutationObserver（替代5个独立观察器，减少内存开销）==========
	let _unifiedObserver = null;

	function startUnifiedObserver() {
		if (_unifiedObserver) return; // 只创建一次
		_unifiedObserver = new MutationObserver((mutations) => {
			// 汉化：处理新增/变更节点
			if (settings.localizationEnabled && !_isTranslating) {
				for (const mutation of mutations) {
					if (mutation.type === 'characterData') {
						enqueue(mutation.target);
						continue;
					}
					if (mutation.type === 'attributes') {
						enqueue(mutation.target);
						continue;
					}
					for (const node of mutation.addedNodes) {
						enqueue(node);
					}
				}
			}
			// 气泡
			onBubblesMutation();
			// 自动继续
			onAutoContinueMutation();
			// 完成提示音
			onCompletionMutation();
			// 对话队列
			onChatQueueMutation();
			// AI提问检测
			detectAiQuestion();
		});
		_unifiedObserver.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ATTRS_TO_TRANSLATE,
		});
		console.log(LOG_PREFIX + '统一观察器已启动');
	}

	// ========== 多轮对话队列 ==========
	let _chatQueue = [];
	let _chatQueueProcessing = false;
	let _chatQueueObserverActive = false;
	let _lastQueueStepCount = 0;
	let _lastQueueCheckTime = 0;
	let _queuePausedForContinue = false; // 配额耗尽/截断时暂停队列，等自动继续恢复后再继续

	function sendQueueMessage(text) {
		const ok = setInputText(text);
		if (!ok) {
			console.log(LOG_PREFIX + '[ChatQueue] 找不到输入框，无法发送');
			return false;
		}
		setTimeout(() => {
			for (const btn of document.querySelectorAll('button[type="submit"]')) {
				const rect = btn.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				const arrowSvg = btn.querySelector('svg.lucide-arrow-up');
				if (!arrowSvg) continue;
				if (btn.classList.contains('cursor-not-allowed') || btn.classList.contains('opacity-50')) continue;
				btn.click();
				console.log(LOG_PREFIX + '[ChatQueue] ✅已发送: "' + text.substring(0, 30) + '..."');
				return;
			}
			// 备用：用回车发送
			const inputEl = findInputEl();
			if (inputEl) {
				inputEl.focus();
				inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
				console.log(LOG_PREFIX + '[ChatQueue] ✅已通过回车发送: "' + text.substring(0, 30) + '..."');
			}
		}, 500);
		return true;
	}

	function processQueue() {
		if (!settings.chatQueueEnabled) return;
		if (_chatQueue.length === 0) {
			_chatQueueProcessing = false;
			console.log(LOG_PREFIX + '[ChatQueue] 队列已空，停止处理');
			notifyEvent('queueDone', '所有对话已处理完毕');
			return;
		}
		_chatQueueProcessing = true;
		const text = _chatQueue.shift();
		console.log(LOG_PREFIX + '[ChatQueue] 📤发送第1条(剩余' + _chatQueue.length + '条): "' + text.substring(0, 30) + '..."');
		// 记录当前step数量，用于判断AI回复完成
		_lastQueueStepCount = document.querySelectorAll('[data-step-index]').length;
		const ok = sendQueueMessage(text);
		if (!ok) {
			_chatQueue.unshift(text);
			_chatQueueProcessing = false;
			console.log(LOG_PREFIX + '[ChatQueue] 发送失败，放回队列');
		}
		// 更新UI
		const statusEl = document.getElementById('ws-cq-status');
		if (statusEl) {
			if (_chatQueue.length === 0) {
				statusEl.textContent = '等待回复中...';
			} else {
				setTrustedHTML(statusEl, '等待回复中... | 剩余' + _chatQueue.length + '条: ' + _chatQueue.map((q, i) => '<span style="color:#9ca3af">' + (i + 1) + '.' + q.substring(0, 15) + (q.length > 15 ? '...' : '') + '</span>').join(' → '));
			}
		}
	}

	function startChatQueueObserver() {
		_chatQueueObserverActive = true;
		// 由统一观察器接管触发
		console.log(LOG_PREFIX + '[ChatQueue] 观察器已启动');
	}

	function onChatQueueMutation() {
		if (!_chatQueueObserverActive || !_chatQueueProcessing || _chatQueue.length === 0) return;
		// 配额耗尽暂停期间，不处理队列（等自动继续恢复A的回答后，_queuePausedForContinue会被重置）
		if (_queuePausedForContinue) return;
		// 节流3秒
		const now = Date.now();
		if (now - _lastQueueCheckTime < 3000) return;
		_lastQueueCheckTime = now;
			// 检测AI是否回复完成：step数量增加了
			const allSteps = document.querySelectorAll('[data-step-index]');
			const currentSteps = allSteps.length;
			if (currentSteps <= _lastQueueStepCount) return;
			// 找最大step-index
			let lastStep = null, maxIdx = -1;
			for (const s of allSteps) {
				const idx = parseInt(s.getAttribute('data-step-index') || '0');
				if (idx > maxIdx) { maxIdx = idx; lastStep = s; }
			}
			if (!lastStep) return;
			// 检查是否是配额耗尽中断或截断
			// 使用统一检测函数：同时搜索banner浮层和step元素
			const quotaResult = detectQuotaExhausted();
			const TRUNCATE_KEYWORDS_CQ = ['继续', 'continue'];
			const lastTextOrig = (lastStep.textContent || '').trim();
			const last5 = lastTextOrig.slice(-5);
			const last8 = lastTextOrig.slice(-8);
			const last10 = lastTextOrig.slice(-10);
			const normalEndings = ['.', '。', '！', '？', '!', '?', ':', '：', ')', '）', ']', '】', '`', '"', "'"];
			const endsNormally = normalEndings.some(e => lastTextOrig.endsWith(e));
			const isTruncated = !endsNormally && (last5.includes('继续') || last8.toLowerCase().includes('continue'));
			if (quotaResult.detected || isTruncated) {
				// 检查AI是否还在生成中（button[type="submit"]里有svg.lucide-square=生成中）
				let isGenerating = false;
				for (const btn of document.querySelectorAll('button[type="submit"]')) {
					if (btn.querySelector('svg.lucide-square')) { isGenerating = true; break; }
				}
				if (isGenerating) {
					console.log(LOG_PREFIX + '[ChatQueue] ⚠️配额耗尽/截断但AI仍在生成中，等待...');
					_lastQueueStepCount = currentSteps;
					return;
				}
				// 关键修复：配额耗尽/截断时，暂停队列，完全交给自动继续机制发送"继续"
				// 不要让队列自己发"继续"，否则可能和自动继续冲突或发错消息
				_queuePausedForContinue = true;
				console.log(LOG_PREFIX + '[ChatQueue] ⏸️配额耗尽/截断，暂停队列，等待自动继续恢复... (队列中还有' + _chatQueue.length + '条消息)');
				// 更新UI
				const statusEl = document.getElementById('ws-cq-status');
				if (statusEl) {
					if (_chatQueue.length === 0) statusEl.textContent = '等待自动继续中...';
					else setTrustedHTML(statusEl, '⏸️等待自动继续恢复... | 剩余' + _chatQueue.length + '条');
				}
				_lastQueueStepCount = currentSteps;
				// 定时检查自动继续是否恢复了AI回复
				const checkResume = () => {
					if (!_queuePausedForContinue) return; // 已恢复
					const stepsNow2 = document.querySelectorAll('[data-step-index]');
					// 使用统一检测函数检查banner+step
					const quotaResult2 = detectQuotaExhausted();
					let lastStep2 = null, maxIdx2 = -1;
					for (const s of stepsNow2) {
						const idx = parseInt(s.getAttribute('data-step-index') || '0');
						if (idx > maxIdx2) { maxIdx2 = idx; lastStep2 = s; }
					}
					if (!lastStep2) { setTimeout(checkResume, 10000); return; }
					const last5_2 = (lastStep2.textContent || '').trim().slice(-5);
					const last8_2 = (lastStep2.textContent || '').trim().slice(-8);
					const endsNormally2 = normalEndings.some(e => (lastStep2.textContent || '').trim().endsWith(e));
					const stillTruncated = !endsNormally2 && (last5_2.includes('继续') || last8_2.toLowerCase().includes('continue'));
					if (quotaResult2.detected || stillTruncated) {
						// 仍然配额耗尽，自动继续可能失败或还在冷却中，继续等待
						console.log(LOG_PREFIX + '[ChatQueue] ⏳仍配额耗尽，继续等待自动继续...');
						setTimeout(checkResume, 15000);
					} else if (stepsNow2.length > currentSteps) {
						// AI有了新回复（step数量增加了），说明自动继续成功
						console.log(LOG_PREFIX + '[ChatQueue] ✅自动继续成功，AI已恢复回复，等A回答完成后继续队列');
						_queuePausedForContinue = false;
						_lastQueueStepCount = stepsNow2.length;
						// 不立即processQueue，等A的回答完全结束后onChatQueueMutation会自动触发
					} else {
						// 没有新回复但也不耗尽了，可能在过渡中
						setTimeout(checkResume, 10000);
					}
				};
				setTimeout(checkResume, 20000); // 20秒后开始检查
				return;
			}
			// 简单判断AI是否完成：step-index增加了且不含exhausted
			// 延迟5秒再确认（等AI生成完毕）
			setTimeout(() => {
				const stepsNow = document.querySelectorAll('[data-step-index]').length;
				if (stepsNow > currentSteps) {
					// 又有新消息了，说明还没完成
					_lastQueueStepCount = stepsNow;
					return;
				}
				console.log(LOG_PREFIX + '[ChatQueue] ✅AI回复完成(step=' + currentSteps + ')，准备发送下一条');
				_lastQueueStepCount = currentSteps;
				setTimeout(() => processQueue(), 1500);
			}, 5000);
	}

	// ========== 自动继续 ==========
	let _quotaContinueCooldown = false;
	let _stableStepCount = { count: -1, hits: 0 }; // 配额耗尽时step稳定性计数
	let _isColdStart = true;
	let _lastAutoContinueThrottle = 0; // 2秒节流（MutationObserver刷屏防护）
	let _lastAutoContinueCheck = 0;     // 15秒最小间隔（防连续触发，AI慢时避免重复发送）
	let _autoContinueActive = false;
	let _tryClickFn = null; // 闭包引用
	let _autoContinueSending = false; // 标记：自动继续正在发送"继续"，完成提示音应忽略此期间的square消失
	let _aiCompletedNormally = false; // 标记：AI已正常完成回复（square→arrow-up确认），空闲监控不应触发
	let _lastCompletedStepIdx = -1;   // 上次正常完成时的最后step索引，用户发新消息后重置
	let _lastQuotaBannerHash = 0;      // 上次处理的banner hash，防止同一个banner重复触发
	let _quotaContinueFailCount = 0;   // 连续发送"继续"但AI无回复的次数
	let _quotaContinueLastStepCount = 0; // 上次发送"继续"时的step数量
	let _lastKnownStepCount = 0;         // 上次检测时的step数量，用于检测聊天切换
	const _windowId = 'ws-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
	function startAutoContinue() {
		if (!settings.autoContinueEnabled) return;
		_autoContinueActive = true;
		// 诊断函数：用户可在控制台输入 wsDiag() 查看当前状态
		window.wsDiag = function() {
			const submitBtn = document.querySelector('button[type="submit"]');
			const inputEl = findInputEl();
			const inputText = inputEl ? (inputEl.textContent || inputEl.value || '').replace(/\u200B/g, '').trim() : '(无输入框)';
			const qr = detectQuotaExhausted();
			const steps = document.querySelectorAll('[data-step-index]').length;
			const diag = {
				version: VERSION,
				_aiCompletedNormally,
				_pluginSettingInput,
				_autoContinueSending,
				_quotaContinueCooldown,
				_userLastKeyTime_ago: Date.now() - _userLastKeyTime + 'ms',
				_stableStepCount,
				_quotaContinueFailCount,
				_lastKnownStepCount: _lastKnownStepCount,
				currentSteps: steps,
				submitBtn_hasSquare: !!(submitBtn && submitBtn.querySelector('svg.lucide-square')),
				submitBtn_hasArrowUp: !!(submitBtn && submitBtn.querySelector('svg.lucide-arrow-up')),
				inputText,
				quotaDetected: qr.detected,
				quotaSource: qr.source,
				quotaElementVisible: qr.element ? (qr.element.getBoundingClientRect().width > 0) : 'N/A',
				settings_autoContinueEnabled: settings.autoContinueEnabled,
				windowId: _windowId,
				lockHolder: (() => { try { const l = JSON.parse(localStorage.getItem('ws-quota-lock')); return l ? l.id + '(' + Math.round((Date.now()-l.time)/1000) + 's ago)' : 'none'; } catch { return 'parse error'; } })(),
				lastSend_ago: Math.round((Date.now() - parseInt(localStorage.getItem('ws-quota-last-send')||'0'))/1000) + 's',
			};
			console.log(LOG_PREFIX + ' ========== 诊断快照 ==========');
			console.table(diag);
			return diag;
		};

		const tryClick = () => {
			if (!settings.autoContinueEnabled) return;
			// 紧急制动：用户可在控制台设置 window.__wsStopAutoContinue=true 停止
			if (window.__wsStopAutoContinue) return;
			// 节流：2秒内不重复检测（避免MutationObserver刷屏）
			const now2 = Date.now();
			if (now2 - _lastAutoContinueThrottle < 2000) return;
			_lastAutoContinueThrottle = now2;
			if (!settings.autoContinueEnabled) return;
			// 聊天切换检测：step数量大幅减少说明用户切换了聊天
			const currentSteps = document.querySelectorAll('[data-step-index]').length;
			if (_lastKnownStepCount > 5 && currentSteps < _lastKnownStepCount - 5) {
				console.log(LOG_PREFIX + '[AutoContinue] 🔄检测到聊天切换(step ' + _lastKnownStepCount + '→' + currentSteps + ')，重置所有状态');
				_aiCompletedNormally = false;
				_lastCompletedStepIdx = -1;
				_quotaContinueFailCount = 0;
				_quotaContinueLastStepCount = 0;
				_lastQuotaBannerHash = 0;
				_stableStepCount = { count: -1, hits: 0 };
			}
			_lastKnownStepCount = currentSteps;
			// 关键守卫：如果AI已正常完成，不应触发任何自动继续
			// 注意：不检查配额banner，因为旧banner会持续存在于DOM中导致守卫失效
			// 配额耗尽时由延迟确认逻辑重置此标志
			if (_aiCompletedNormally) {
				return;
			}
			// 状态快照：每次走到这里时记录关键变量
			const _snapshot = {
				aiCompleted: _aiCompletedNormally,
				pluginInput: _pluginSettingInput,
				sending: _autoContinueSending,
				cooldown: _quotaContinueCooldown,
				userKeyAgo: Date.now() - _userLastKeyTime,
				stableStep: JSON.stringify(_stableStepCount),
				failCount: _quotaContinueFailCount,
			};
			console.log(LOG_PREFIX + '[AutoContinue] 📸状态快照: ' + JSON.stringify(_snapshot));
			// 1. 原有逻辑：检测 "Continue response" / "继续回复" 按钮
			const btns = document.querySelectorAll('button, [role="button"]');
			for (const btn of btns) {
				const txt = (btn.textContent || '').trim();
				if (txt === 'Continue response' || txt === '继续回复') {
					console.error(LOG_PREFIX + '🔴路径1触发: 检测到"Continue response"按钮，即将点击');
					console.trace(LOG_PREFIX + '路径1调用栈');
					setTimeout(() => btn.click(), 800);
					return;
				}
			}
			// 2. 新增逻辑：检测配额耗尽提示，检查配额余额后自动输入"继续"并发送
			// 如果用户正在输入（输入框有焦点且有内容），不触发自动继续
			// 关键修复：检测用户输入时，还要检查submit按钮状态
			// arrow-up + 无cursor-not-allowed = 用户已输入文字，此时不应触发自动继续
			const activeEl = document.activeElement;
			let userIsTyping = false;
			// 检查1: 输入框有焦点且有内容（包括"继续"——用户手动输入的"继续"不应被覆盖）
			if (activeEl && (activeEl.getAttribute('data-lexical-editor') === 'true' || activeEl.contentEditable === 'true' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
				const activeText = (activeEl.textContent || activeEl.value || '').replace(/\u200B/g, '').trim();
				if (activeText.length > 0) {
					// 用户手动输入了内容（包括"继续"），检查是否是用户键盘输入的
					if (Date.now() - _userLastKeyTime < 5000) {
						userIsTyping = true;
						console.log(LOG_PREFIX + '[AutoContinue] ✋用户手动输入了"' + activeText.substring(0, 30) + '"，跳过自动继续');
					} else if (activeText !== '继续') {
						// 非键盘输入但有非"继续"内容，可能是粘贴等
						userIsTyping = true;
						console.log(LOG_PREFIX + '[AutoContinue] ✋输入框有用户内容("' + activeText.substring(0, 30) + '...")，跳过自动继续');
					}
				}
			}
			// 检查2: submit按钮显示arrow-up且可点击(无cursor-not-allowed) = 用户已输入文字
			if (!userIsTyping) {
				for (const btn of document.querySelectorAll('button[type="submit"]')) {
					const rect = btn.getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) continue;
					if (btn.querySelector('svg.lucide-arrow-up') && !btn.classList.contains('cursor-not-allowed') && !btn.classList.contains('opacity-50')) {
						// 按钮可发送 = 输入框有内容，可能是用户输入的
						// 但也可能是自动继续刚写入的，检查输入框内容
						const inputEl = findInputEl();
						if (inputEl) {
							const inputText = (inputEl.textContent || inputEl.value || '').replace(/\u200B/g, '').trim();
							if (inputText.length > 0) {
								// 用户手动输入了"继续"或其他内容
								if (Date.now() - _userLastKeyTime < 5000) {
									userIsTyping = true;
									console.log(LOG_PREFIX + '[AutoContinue] ✋用户手动输入了"' + inputText.substring(0, 30) + '"，跳过自动继续');
									break;
								} else if (inputText !== '继续') {
									userIsTyping = true;
									console.log(LOG_PREFIX + '[AutoContinue] ✋按钮可发送且输入框有用户文字("' + inputText.substring(0, 30) + '...")，跳过自动继续');
									break;
								}
							}
						}
					}
				}
			}
			if (userIsTyping) return;
			// 5秒最小间隔：防止连续触发，同时快速检测配额
			const now = Date.now();
			if (now - _lastAutoContinueCheck < 5000) { return; }
			if (_quotaContinueCooldown) { console.log(LOG_PREFIX + '[AutoContinue] ⏳冷却中，跳过'); return; }
			// 冷却检查：10秒内不重复发送（用localStorage跨窗口共享）
			const lastSend = parseInt(localStorage.getItem('ws-quota-last-send') || '0');
			if (now - lastSend < 5000) { console.log(LOG_PREFIX + '[AutoContinue] ⏳全局冷却中(' + Math.round((5000 - (now - lastSend)) / 1000) + 's)，跳过'); return; }
			// 跨窗口锁：用localStorage，记录获得锁的窗口ID
			const lockData = localStorage.getItem('ws-quota-lock');
			if (lockData) {
				try {
					const lock = JSON.parse(lockData);
					if (lock.id !== _windowId && now - lock.time < 15000) {
						console.log(LOG_PREFIX + '[AutoContinue] 另一个窗口(' + lock.id + ')已获得锁，跳过');
						return;
					}
				} catch {}
			}

			// 配额耗尽检测：使用统一函数同时搜索banner浮层和step元素
			// Windsurf新版本配额耗尽显示为顶部banner，不在[data-step-index]中
			const quotaResult = detectQuotaExhausted();
			const allSteps = document.querySelectorAll('[data-step-index]');
			console.log(LOG_PREFIX + '[AutoContinue] 🔍检测: quotaResult=' + quotaResult.detected + '(source=' + quotaResult.source + '), step-index元素=' + allSteps.length);

			// 连续失败检查：如果之前发送过"继续"但step没增加，说明配额真耗尽了
			if (_quotaContinueFailCount > 0) {
				const currentStepCount = allSteps.length;
				if (currentStepCount > _quotaContinueLastStepCount) {
					// step增加了！AI有新回复，重置失败计数
					console.log(LOG_PREFIX + '[AutoContinue] ✅上次发送"继续"后AI有新回复(step ' + _quotaContinueLastStepCount + '→' + currentStepCount + ')，重置失败计数');
					_quotaContinueFailCount = 0;
				} else {
					// step没增加，累计失败
					_quotaContinueFailCount++;
					console.log(LOG_PREFIX + '[AutoContinue] ⚠️连续失败次数=' + _quotaContinueFailCount + '(step未增加: ' + _quotaContinueLastStepCount + '→' + currentStepCount + ')');
					if (_quotaContinueFailCount >= 3) {
						console.log(LOG_PREFIX + '[AutoContinue] 🚫连续3次发送"继续"但AI无回复，配额真正耗尽，放弃');
						notifyEvent('quotaExhaust', '连续发送"继续"无效，配额已耗尽，请充值或等待配额重置');
						_quotaContinueCooldown = true;
						_quotaContinueFailCount = 0;
						setTimeout(() => { _quotaContinueCooldown = false; }, 60000); // 1分钟后重试
						return;
					}
				}
			}

			// 找最后一个AI文本步骤（而非命令步骤），用于截断检测
			const lastAiStep = findLastAiTextStep();
			let lastStep = lastAiStep ? lastAiStep.el : null;
			let maxIndex = lastAiStep ? lastAiStep.idx : -1;
			let lastTextOriginal = '';
			let last10Chars = '';
			if (lastStep) {
				lastTextOriginal = (lastStep.textContent || '').trim();
				last10Chars = lastTextOriginal.slice(-10);
				console.log(LOG_PREFIX + '[AutoContinue] 📋AI文本步骤(step=' + maxIndex + '): 文本前80字="' + lastTextOriginal.substring(0, 80) + '..." | 最后10字="' + last10Chars + '"');
			} else {
				// 没有AI文本步骤，只有命令步骤 — 不需要截断检测
				console.log(LOG_PREFIX + '[AutoContinue] 📋无AI文本步骤(只有命令步骤)，跳过截断检测');
			}

			// 判断1: 配额耗尽（banner或step）
			const isQuotaExhausted = quotaResult.detected;
			// 关键守卫：如果AI已正常完成（square→arrow-up确认），不应触发任何自动继续
			// 但配额耗尽时AI是被强制停止的，不是正常完成，需要绕过此检查
			if (_aiCompletedNormally && !isQuotaExhausted) {
				console.log(LOG_PREFIX + '[AutoContinue] ❌AI已正常完成(aiCompleted=true)，跳过所有自动继续');
				return;
			}
			if (_aiCompletedNormally && isQuotaExhausted) {
				console.log(LOG_PREFIX + '[AutoContinue] ⚠️配额耗尽但aiCompleted=true，重置标志允许发送');
				_aiCompletedNormally = false;
			}
			// 额外守卫：检查banner元素是否真的可见（不是display:none或已关闭）
			if (isQuotaExhausted && quotaResult.element) {
				try {
					const bannerRect = quotaResult.element.getBoundingClientRect();
					if (bannerRect.width === 0 || bannerRect.height === 0) {
						console.log(LOG_PREFIX + '[AutoContinue] ❌banner元素不可见(宽或高为0)，跳过');
						return;
					}
				} catch {}
			}
			// 判断2: 回复截断（严格匹配：关键词必须在末尾，且回复未以正常标点结束）
			const last5 = lastTextOriginal.slice(-5);
			const last8 = lastTextOriginal.slice(-8);
			const normalEndings = ['.', '。', '！', '？', '!', '?', ':', '：', ')', '）', ']', '】', '`', '"', "'", '}', '>'];
			const endsNormally = normalEndings.some(e => lastTextOriginal.endsWith(e));
			// 截断判定：1)不以正常标点结尾 2)末尾含继续/continue 3)AI未正常完成
			// 或：文本中包含"Permission denied:"（权限错误，需要重试）
			const hasPermissionDenied = lastTextOriginal.includes('Permission denied:');
			const isTruncated = !endsNormally && (last5.includes('继续') || last8.toLowerCase().includes('continue'));

			if (!isQuotaExhausted && !isTruncated && !hasPermissionDenied) {
				console.log(LOG_PREFIX + '[AutoContinue] ❌无配额耗尽banner/step且无截断/权限错误，正常完成不触发');
				return;
			}
			// 如果没有AI文本步骤，只有命令步骤，不应触发截断继续
			if (!lastStep && !isQuotaExhausted) {
				console.log(LOG_PREFIX + '[AutoContinue] ❌无AI文本步骤且无配额耗尽，不触发');
				return;
			}

			// 关键守卫：如果AI正在生成中（submit按钮显示square/stop图标），不需要发"继续"
			// 但配额耗尽时AI已停，square图标可能残留，需要绕过此检查
			if (!isQuotaExhausted) {
				const submitBtn = document.querySelector('button[type="submit"]');
				if (submitBtn) {
					const isGenerating = submitBtn.querySelector('svg.lucide-square') !== null;
					if (isGenerating) {
						console.log(LOG_PREFIX + '[AutoContinue] ❌AI正在生成中(square图标)，不需要发送"继续"');
						return;
					}
				}
			} else {
				// 配额耗尽时：square图标可能残留，用step稳定性判断AI是否真的停了
				// 连续两轮step数不变才算稳定
				const currentSteps = document.querySelectorAll('[data-step-index]').length;
				if (currentSteps === _stableStepCount.count) {
					_stableStepCount.hits++;
				} else {
					_stableStepCount.count = currentSteps;
					_stableStepCount.hits = 1;
				}
				if (_stableStepCount.hits < 2) {
					console.log(LOG_PREFIX + '[AutoContinue] ⏳配额耗尽但step还在变化(' + currentSteps + ', stable=' + _stableStepCount.hits + ')，等下一轮');
					return;
				}
				console.log(LOG_PREFIX + '[AutoContinue] ✅step稳定(' + currentSteps + '×' + _stableStepCount.hits + ')，配额耗尽确认AI已停');
			}

			// 配额耗尽时：如果AI文本以正常标点结尾，说明AI已完成回复，banner是过期的
			// 只有AI文本被截断（不以正常标点结尾）时才需要发"继续"
			if (isQuotaExhausted) {
				if (!lastStep) {
					// 无AI文本步骤，配额banner可能是过期的
					console.log(LOG_PREFIX + '[AutoContinue] ❌配额耗尽但无AI文本步骤，banner可能过期，跳过');
					return;
				}
				const normalEndings = ['.', '。', '！', '？', '!', '?', ':', '：', ')', '）', ']', '】', '`', '"', "'", '}', '>'];
				const endsNormally = normalEndings.some(e => lastTextOriginal.endsWith(e));
				if (endsNormally) {
					console.log(LOG_PREFIX + '[AutoContinue] ❌配额耗尽但AI文本以正常标点结尾("' + last10Chars + '")，banner可能过期，跳过');
					return;
				}
				console.log(LOG_PREFIX + '[AutoContinue] ✅配额耗尽+AI文本未正常结尾("' + last10Chars + '")，确认需要发送"继续"');
			}
			// 配额耗尽时直接发"继续"，不切号

			const triggerReason = isQuotaExhausted ? '配额耗尽(source=' + quotaResult.source + ')' : (hasPermissionDenied ? '权限错误(Permission denied)' : '回复截断(末尾含"' + last10Chars + '")');
			console.log(LOG_PREFIX + '[AutoContinue] ✅触发: ' + triggerReason);
			// 触发时完整状态快照
			console.log(LOG_PREFIX + '[AutoContinue] 📸触发快照: ' + JSON.stringify({
				aiCompleted: _aiCompletedNormally,
				pluginInput: _pluginSettingInput,
				sending: _autoContinueSending,
				cooldown: _quotaContinueCooldown,
				userKeyAgo: Date.now() - _userLastKeyTime,
				stableStep: _stableStepCount,
				failCount: _quotaContinueFailCount,
				isQuotaExhausted,
				quotaSource: quotaResult.source,
				submitBtn_hasSquare: !!(document.querySelector('button[type="submit"]')?.querySelector('svg.lucide-square')),
				inputText: (() => { const el = findInputEl(); return el ? (el.textContent||el.value||'').replace(/\u200B/g,'').trim().substring(0,30) : 'N/A'; })(),
			}));

			// 防重复：记录已处理的alert签名（简单hash）
			// 关键修复：handledKey存储时间戳，120秒内视为已处理
			// 与冷却期匹配，防止同一个banner在冷却结束后被重复触发
			// 使用banner或step的文本作为hash源
			const alertText = (quotaResult.element?.textContent || lastStep?.textContent || '').substring(0, 100);
			let alertHash = 0;
			for (let i = 0; i < alertText.length; i++) alertHash = ((alertHash << 5) - alertHash + alertText.charCodeAt(i)) | 0;
			const handledKey = 'ws-quota-handled-' + alertHash;
			const handledValue = localStorage.getItem(handledKey);
			if (handledValue) {
				const handledTime = parseInt(handledValue);
				if (!isNaN(handledTime) && (now - handledTime) < 120000) {
					console.log(LOG_PREFIX + '[AutoContinue] ⏳已处理过的alert(hash=' + alertHash + ', ' + Math.round((120000 - (now - handledTime)) / 1000) + 's前)，跳过');
					return;
				}
				// 超过120秒，说明之前的发送可能失败了，清除并重试
				console.log(LOG_PREFIX + '[AutoContinue] ⚠️handledKey已过期(' + Math.round((now - handledTime) / 1000) + 's前)，清除并重试');
				localStorage.removeItem(handledKey);
			}

			// 清理过期的 ws-quota-handled-* 键（保留最近10个，防止localStorage无限累积）
			// 同时清理旧的'1'值（之前发送失败时设置的，不含时间戳）
			try {
				const handledKeys = [];
				for (let i = 0; i < localStorage.length; i++) {
					const k = localStorage.key(i);
					if (k && k.startsWith('ws-quota-handled-')) {
						const v = localStorage.getItem(k);
						// 清理旧格式（值为'1'而非时间戳）或超过5分钟的记录
						if (v === '1' || (parseInt(v) && (now - parseInt(v)) > 300000)) {
							localStorage.removeItem(k);
						} else {
							handledKeys.push(k);
						}
					}
				}
				if (handledKeys.length > 10) {
					handledKeys.sort();
					for (let i = 0; i < handledKeys.length - 10; i++) {
						localStorage.removeItem(handledKeys[i]);
					}
				}
			} catch {}

			// 二次验证（仅step来源的配额耗尽时检查图标，banner来源和截断不检查）
			if (isQuotaExhausted && quotaResult.source === 'step' && lastStep) {
				const hasAlertIcon = lastStep.querySelector('svg.lucide-triangle-alert');
				const hasQuotaBg = lastStep.querySelector('[class*="bg-neutral-500/20"], [class*="bg-red-600"], [class*="bg-red-500"]');
				console.log(LOG_PREFIX + '[AutoContinue] 🔍二次验证(step配额): alertIcon=' + !!hasAlertIcon + ', quotaBg=' + !!hasQuotaBg);
				if (!hasAlertIcon && !hasQuotaBg) {
					console.log(LOG_PREFIX + '[AutoContinue] ⚠️无triangle-alert/quotaBg图标，但文本匹配通过，继续发送');
				}
			} else if (isQuotaExhausted && quotaResult.source === 'banner') {
				console.log(LOG_PREFIX + '[AutoContinue] 🔍banner来源配额耗尽，跳过图标二次验证（banner自带红/黄背景）');
			} else {
				console.log(LOG_PREFIX + '[AutoContinue] 🔍截断触发，跳过图标二次验证');
			}

			// 执行发送"继续"的逻辑（含重试）
			const doSendContinue = (delay) => {
				_quotaContinueCooldown = true;
				_autoContinueSending = true; // 标记：自动继续正在发送，完成提示音应忽略
				_lastAutoContinueCheck = Date.now(); // 更新5秒间隔标记
				localStorage.setItem('ws-quota-lock', JSON.stringify({ id: _windowId, time: Date.now() }));
				console.error(LOG_PREFIX + '🔴路径2触发: doSendContinue配额耗尽，即将发送"继续"(hash=' + alertHash + ')');
				console.trace(LOG_PREFIX + '路径2调用栈');
				// 通知用户：检测到配额耗尽
				notifyEvent('quotaExhaust', '正在自动换号继续...');

				const trySend = (attempt) => {
					if (attempt > 8) {
						console.log(LOG_PREFIX + '[AutoContinue] 重试8次仍无法发送，放弃');
						_quotaContinueCooldown = false;
						_autoContinueSending = false;
						localStorage.removeItem('ws-quota-lock');
						return;
					}

					// 检查用户是否正在输入——如果是，立即放弃
					const preCheck = findInputEl();
					if (preCheck) {
						const preText = (preCheck.textContent || preCheck.value || '').replace(/\u200B/g, '').trim();
						if (preText.length > 0 && preText !== '继续') {
							console.log(LOG_PREFIX + '[AutoContinue] ✋检测到用户输入"' + preText.substring(0, 30) + '"，立即放弃重试');
							_quotaContinueCooldown = false;
							_autoContinueSending = false;
							localStorage.removeItem('ws-quota-lock');
							return;
						}
					}

					// 检查输入框是否已有"继续"累积（防止"继续继续继续..."）
					const preInput2 = findInputEl();
					if (preInput2) {
						const preText = (preInput2.textContent || preInput2.value || '').replace(/\u200B/g, '').trim();
						if (preText.includes('继续') && preText !== '继续') {
							console.log(LOG_PREFIX + '[AutoContinue] ⚠️输入框含异常文本"' + preText.substring(0, 30) + '"，先清空');
							preInput2.focus();
							try { document.execCommand('selectAll'); document.execCommand('delete'); } catch {}
							try { document.execCommand('selectAll'); document.execCommand('delete'); } catch {}
						}
					}

					// 检查是否已有排队的"继续"消息（避免重复发送）
					const chatRoot2 = findChatRoot() || document;
					const allSpans = chatRoot2.querySelectorAll('span');
					for (const span of allSpans) {
						const spanText = (span.textContent || '').toLowerCase();
						if (spanText.includes('message queued') || spanText.includes('messages queued') || spanText.includes('条消息排队中')) {
							const queueArea = span.closest('div.flex.flex-col') || span.closest('[class*="flex-col"]') || span.parentElement?.parentElement;
							if (queueArea && queueArea.textContent.includes('继续')) {
								console.log(LOG_PREFIX + '[AutoContinue] 已有排队的"继续"消息，跳过');
								_quotaContinueCooldown = false;
								_autoContinueSending = false;
								localStorage.removeItem('ws-quota-lock');
								return;
							}
						}
					}

					// 保存用户当前输入
					const inputEl = findInputEl();
					let userText = '';
					let hasUserInput = false;
					if (inputEl) {
						if (inputEl.getAttribute('data-lexical-editor') === 'true' || inputEl.contentEditable === 'true') {
							userText = (inputEl.textContent || '').replace(/\u200B/g, '').trim();
						} else if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
							userText = (inputEl.value || '').trim();
						}
						hasUserInput = userText.length > 0 && userText !== '继续';
						if (hasUserInput) {
							console.log(LOG_PREFIX + '[AutoContinue] 保存用户输入: "' + userText.substring(0, 50) + '..."');
						}
					}

					// setInputText内部已有clearLexical清空逻辑，不需要额外预清空
					console.log(LOG_PREFIX + '[AutoContinue] 📝第' + attempt + '次尝试: setInputText("继续")...');
					const ok = setInputText('继续');
					if (!ok) { console.log(LOG_PREFIX + '[AutoContinue] 找不到输入框，跳过'); _quotaContinueCooldown = false; return; }

					// 验证文本是否真的写入了
					const inputEl2 = findInputEl();
					if (inputEl2) {
						const textAfter = (inputEl2.textContent || inputEl2.value || '').replace(/\u200B/g, '').trim();
						console.log(LOG_PREFIX + '[AutoContinue] 📝写入后验证: "' + textAfter.substring(0, 30) + '" (期望"继续")');
						if (textAfter !== '继续') {
							console.log(LOG_PREFIX + '[AutoContinue] ⚠️文本未正确写入，第' + attempt + '次重试...');
							setTimeout(() => trySend(attempt + 1), 3000);
							return;
						}
					}

					// 写入成功后：先等Lexical同步状态，再发送
					// 关键修复：Lexical需要时间处理InputEvent，立即按Enter可能被忽略
					setTimeout(() => {
						const inputEl3 = findInputEl();
						if (inputEl3) {
							inputEl3.focus();
							// 优先点击submit按钮（比Enter更可靠）
							let sentByBtn = false;
							for (const btn of document.querySelectorAll('button[type="submit"]')) {
								const rect = btn.getBoundingClientRect();
								if (rect.width === 0 || rect.height === 0) continue;
								const arrowSvg = btn.querySelector('svg.lucide-arrow-up');
								if (!arrowSvg) continue;
								if (btn.classList.contains('cursor-not-allowed') || btn.classList.contains('opacity-50')) continue;
								btn.click();
								sentByBtn = true;
								console.log(LOG_PREFIX + '[AutoContinue] 📤已点击submit按钮');
								break;
							}
							if (!sentByBtn) {
								// 兜底：Enter键发送
								const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, shiftKey: false, isComposing: false });
								const targets = new Set([inputEl3, inputEl3.parentElement, inputEl3.closest('[role="textbox"]'), document.activeElement].filter(Boolean));
								for (const t of targets) { t.dispatchEvent(enterEvent); }
								for (const t of targets) { t.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }
								for (const t of targets) { t.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }
								console.log(LOG_PREFIX + '[AutoContinue] 📤已发送Enter键(兜底)');
							}
						}
					}, 300); // 等300ms让Lexical同步状态

					// 验证发送结果：300ms已发送，等800ms后检查输入框是否清空
					setTimeout(() => {
						const inputEl4 = findInputEl();
						if (inputEl4) {
							const textAfterSend = (inputEl4.textContent || inputEl4.value || '').replace(/\u200B/g, '').trim();
							if (textAfterSend === '继续') {
								// 输入框仍含"继续"，发送失败，重试
								console.log(LOG_PREFIX + '[AutoContinue] ❌发送后输入框仍含"继续"，第' + attempt + '次重试...');
								setTimeout(() => trySend(attempt + 1), 5000);
								return;
							}
						}
						// ✅ 确认发送成功
						console.log(LOG_PREFIX + '[AutoContinue] ✅✅发送"继续"成功！(attempt=' + attempt + ')');
						localStorage.setItem(handledKey, Date.now().toString());
						localStorage.setItem('ws-quota-last-send', Date.now().toString());
						notifyEvent('autoContinue', '配额耗尽/截断，已自动发送"继续"');
						_queuePausedForContinue = false;
						// 记录当前step数量，下次检测时如果没增加则累计失败
						_quotaContinueLastStepCount = document.querySelectorAll('[data-step-index]').length;
						// 首次发送时初始化失败计数为1（下次检测时如果step没增加会继续累加）
						if (_quotaContinueFailCount === 0) _quotaContinueFailCount = 1;

						if (hasUserInput) {
							setTimeout(() => {
								setInputText(userText);
								console.log(LOG_PREFIX + '[AutoContinue] 已恢复用户输入');
							}, 800);
						}
						_lastQueueStepCount = document.querySelectorAll('[data-step-index]').length;
						// 发送成功后冷却15秒（配额耗尽时允许快速重试）
						// 主动释放跨窗口锁，允许其他窗口响应
						localStorage.removeItem('ws-quota-lock');
						setTimeout(() => { _quotaContinueCooldown = false; _autoContinueSending = false; }, 15000);
					}, 800);
				};
				setTimeout(() => trySend(1), delay);
			};

			// 判断冷启动 vs 非冷启动
			// 冷启动：插件刚初始化，服务可能还在连接，等15秒
			// 非冷启动：运行中检测到配额耗尽，直接发送
			if (_isColdStart) {
				console.log(LOG_PREFIX + '[AutoContinue] 冷启动模式，等待5秒后发送');
				doSendContinue(5000);
				_isColdStart = false;
			} else {
				console.log(LOG_PREFIX + '[AutoContinue] 运行中模式，直接发送');
				doSendContinue(0);
			}
		};
		_tryClickFn = tryClick; // 保存闭包引用
		// 冷启动：延迟检查当前对话框是否已有配额耗尽提示
		setTimeout(() => { tryClick(); }, 3000);
		console.log(LOG_PREFIX + '[AutoContinue] ✅已启用');
	}

	function onAutoContinueMutation() {
		if (!_autoContinueActive || !settings.autoContinueEnabled) return;
		if (_tryClickFn) _tryClickFn();
	}

	// ========== 拦截Windsurf自带Auto-Continue ==========
	// Windsurf有内置的Auto-Continue设置，会在配额耗尽时自动发"继续"
	// 当我们的插件判定AI已完成时，需要拦截Windsurf自带的"继续"
	function startInputGuard() {
		const guardInterval = setInterval(() => {
			if (!_aiCompletedNormally) return;
			if (_pluginSettingInput) return; // 我们自己设的，不拦截
			if (Date.now() - _userLastKeyTime < 5000) return; // 用户5秒内输入的，不拦截
			const inputEl = findInputEl();
			if (!inputEl) return;
			const text = (inputEl.textContent || inputEl.value || '').replace(/\u200B/g, '').trim();
			if (text === '继续') {
				console.error(LOG_PREFIX + '🔴拦截Windsurf自带Auto-Continue: AI已完成但输入框出现"继续"，清空');
				// 清空输入框
				if (inputEl.getAttribute('data-lexical-editor') === 'true') {
					try {
						const editorKey = Object.keys(inputEl).find(k => k.startsWith('__lexicalEditor'));
						if (editorKey) {
							const editor = inputEl[editorKey];
							if (editor && editor.update) {
								editor.update(() => {
									const state = editor.getEditorState();
									state.read(() => {
										const root = state._nodeMap.get('root');
										if (root) root.clear();
									});
								});
							}
						}
					} catch(e) {
						console.log(LOG_PREFIX + '[InputGuard] 清空Lexical失败: ' + e.message);
					}
				} else {
					inputEl.textContent = '';
					inputEl.value = '';
				}
				inputEl.dispatchEvent(new Event('input', { bubbles: true }));
			}
		}, 1000);
	}

	// ========== 提交拦截器：阻止非插件来源的"继续"发送 ==========
	// 拦截submit按钮点击和Enter键，当输入框是"继续"且不是我们插件设的、也不是用户手动输入的时，阻止发送
	// 这可以拦截星火插件、Windsurf自带Auto-Continue等自动化来源的"继续"
	let _userLastKeyTime = 0; // 用户最后一次按键时间
	function startSubmitInterceptor() {
		// 追踪用户键盘活动（区分用户手动输入 vs 程序自动输入）
		document.addEventListener('keydown', (e) => {
			const inputEl = findInputEl();
			if (inputEl && (e.target === inputEl || inputEl.contains(e.target) || e.target.closest('[role="textbox"]'))) {
				_userLastKeyTime = Date.now();
			}
		}, true);

		// 拦截submit按钮点击
		document.addEventListener('click', (e) => {
			if (_pluginSettingInput) return; // 我们自己设的，放行
			// 用户5秒内有过键盘输入，视为手动输入，放行
			if (Date.now() - _userLastKeyTime < 5000) return;
			const btn = e.target.closest('button[type="submit"]');
			if (!btn) return;
			const rect = btn.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;
			const inputEl = findInputEl();
			if (!inputEl) return;
			const text = (inputEl.textContent || inputEl.value || '').replace(/\u200B/g, '').trim();
			if (text === '继续') {
				console.error(LOG_PREFIX + '🔴提交拦截: 阻止非插件来源的"继续"发送(来源: 星火/Windsurf自带Auto-Continue)');
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				// 清空输入框
				try {
					if (inputEl.getAttribute('data-lexical-editor') === 'true') {
						const editorKey = Object.keys(inputEl).find(k => k.startsWith('__lexicalEditor'));
						if (editorKey) {
							const editor = inputEl[editorKey];
							if (editor && editor.update) {
								editor.update(() => {
									const state = editor.getEditorState();
									state.read(() => {
										const root = state._nodeMap.get('root');
										if (root) root.clear();
									});
								});
							}
						}
					} else {
						inputEl.textContent = '';
						inputEl.value = '';
					}
					inputEl.dispatchEvent(new Event('input', { bubbles: true }));
				} catch(err) {
					console.log(LOG_PREFIX + '[SubmitInterceptor] 清空失败: ' + err.message);
				}
			}
		}, true); // capture阶段拦截，最先执行

		// 拦截Enter键发送
		document.addEventListener('keydown', (e) => {
			if (_pluginSettingInput) return;
			if (e.key !== 'Enter') return;
			// 用户自己按的Enter（5秒内有过键盘输入），放行
			if (Date.now() - _userLastKeyTime < 5000) return;
			const inputEl = findInputEl();
			if (!inputEl) return;
			const text = (inputEl.textContent || inputEl.value || '').replace(/\u200B/g, '').trim();
			if (text === '继续') {
				console.error(LOG_PREFIX + '🔴Enter拦截: 阻止非插件来源的"继续"发送');
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
			}
		}, true);
	}

	// ========== 通知与提示音 ==========
	let _completionActive = false;
	let _wasGenerating = false;
	let _pendingSoundTimer = null;
	let _completionTimer = 0;
	let _checkCompletionFn = null;

	const SOUND_PRESETS = {
		chime: [ { freq: 523.25, start: 0, dur: 0.12 }, { freq: 659.25, start: 0.13, dur: 0.12 }, { freq: 783.99, start: 0.26, dur: 0.18 } ],
		ding: [ { freq: 880, start: 0, dur: 0.15 }, { freq: 660, start: 0.18, dur: 0.2 } ],
		pop: [ { freq: 1200, start: 0, dur: 0.06 }, { freq: 900, start: 0.08, dur: 0.08 }, { freq: 1100, start: 0.18, dur: 0.06 } ],
		alert: [ { freq: 440, start: 0, dur: 0.1 }, { freq: 440, start: 0.15, dur: 0.1 }, { freq: 880, start: 0.3, dur: 0.2 } ],
		soft: [ { freq: 440, start: 0, dur: 0.2 }, { freq: 554.37, start: 0.22, dur: 0.25 } ],
		warn: [ { freq: 600, start: 0, dur: 0.08 }, { freq: 400, start: 0.1, dur: 0.15 }, { freq: 600, start: 0.28, dur: 0.08 }, { freq: 400, start: 0.38, dur: 0.15 } ],
	};

	// 事件类型定义：{ icon, defaultSound }
	const NOTIFY_EVENTS = {
		complete:     { icon: '✅', label: 'AI回复完成',     sound: 'chime' },
		autoContinue: { icon: '🔄', label: '自动发送继续',   sound: 'soft' },
		quotaExhaust: { icon: '⚠️', label: '配额耗尽',       sound: 'warn' },
		queueDone:    { icon: '🎉', label: '队列全部完成',   sound: 'ding' },
		aiQuestion:  { icon: '❓', label: 'AI需要你的输入', sound: 'alert' },
	};

	let _audioCtx = null;

	function playNotifySound(preset) {
		if (!settings.notifySoundEnabled) return;
		try {
			if (!_audioCtx || _audioCtx.state === 'closed') {
				_audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			}
			if (_audioCtx.state === 'suspended') { _audioCtx.resume(); }
			const ctx = _audioCtx;
			const vol = (settings.notifySoundVolume || 0.3) * 2.5;
			const notes = SOUND_PRESETS[preset || settings.notifySoundPreset] || SOUND_PRESETS.chime;
			const master = ctx.createGain();
			master.gain.value = 1;
			master.connect(ctx.destination);
			notes.forEach(n => {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'triangle';
				osc.frequency.value = n.freq;
				gain.gain.setValueAtTime(0.001, ctx.currentTime + n.start);
				gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + n.start + 0.01);
				gain.gain.setValueAtTime(vol, ctx.currentTime + n.start + n.dur * 0.6);
				gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + n.start + n.dur);
				osc.connect(gain);
				gain.connect(master);
				osc.start(ctx.currentTime + n.start);
				osc.stop(ctx.currentTime + n.start + n.dur + 0.05);
			});
			console.log(LOG_PREFIX + '[Notify] 🔔提示音已播放(' + (preset || settings.notifySoundPreset) + ')');
		} catch (e) {
			console.log(LOG_PREFIX + '[Notify] 播放失败:', e);
		}
	}

	function notifyEvent(eventType, detail) {
		const ev = NOTIFY_EVENTS[eventType];
		if (!ev) return;
		const settingKey = 'notifyOn' + eventType.charAt(0).toUpperCase() + eventType.slice(1);
		// 检查该事件的通知开关
		if (!settings[settingKey]) {
			console.log(LOG_PREFIX + '[Notify] ⏭️' + ev.label + '通知已关闭，跳过');
			return;
		}
		// 播放提示音（每种事件有默认音色，但用户可在设置中统一切换）
		playNotifySound(ev.sound);
		// 系统通知
		if (settings.notifySystemEnabled) {
			try {
				if (Notification.permission === 'default') Notification.requestPermission();
				if (Notification.permission === 'granted') {
					const n = new Notification('Windsurf Better', {
						body: ev.icon + ' ' + ev.label + (detail ? ' - ' + detail : ''),
						icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">' + ev.icon + '</text></svg>',
						silent: true,
					});
					setTimeout(() => n.close(), 5000);
				}
			} catch (e) { console.log(LOG_PREFIX + '[Notify] 系统通知失败:', e); }
		}
		console.log(LOG_PREFIX + '[Notify] 📢' + ev.icon + ' ' + ev.label + (detail ? ' (' + detail + ')' : ''));
	}

	function startNotificationSound() {
		_completionActive = false;
		_checkCompletionFn = null;
		if (!settings.notifySoundEnabled) return;

		const checkCompletion = () => {
			if (!settings.notifySoundEnabled) return;

			// 核心检测：仅 lucide-square（■ 停止图标）为AI生成中的可靠标志
			// arrow-up + cursor-pointer = 用户输入了文字（排队发送），不是AI生成
			// arrow-up + cursor-not-allowed = 空闲
			// square = AI正在生成
			let hasSquare = false;
			const submitBtns = document.querySelectorAll('button[type="submit"]');
			for (const btn of submitBtns) {
				const rect = btn.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				if (btn.querySelector('svg.lucide-square')) {
					hasSquare = true;
					break;
				}
			}

			// 兜底：检测停止按钮（旧版UI兼容）
			if (!hasSquare) {
				const allBtns = document.querySelectorAll('button');
				for (const btn of allBtns) {
					const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
					const txt = (btn.textContent || '').trim().toLowerCase();
					if (ariaLabel.includes('stop') || txt === 'stop' || txt === '停止') {
						const rect = btn.getBoundingClientRect();
						if (rect.width > 0 && rect.height > 0) { hasSquare = true; break; }
					}
				}
			}

			// 状态机：仅 square 出现→消失 才算AI完成
			if (hasSquare) {
				// 检测到 square = AI正在生成
				_wasGenerating = true;
				// 重置AI正常完成标志（新回复开始了）
				if (_aiCompletedNormally) {
					console.log(LOG_PREFIX + '[Notify] 🔄AI开始新回复，重置完成标志');
					_aiCompletedNormally = false;
				}
				// 取消待触发的提示音（防止square短暂消失又出现）
				if (_pendingSoundTimer) { clearTimeout(_pendingSoundTimer); _pendingSoundTimer = null; }
			} else if (_wasGenerating) {
				// square 消失，AI可能已完成
				// 关键修复：立即设置_aiCompletedNormally=true，防止tryClick在延迟期间误触发
				// 如果后续发现是配额耗尽或AI重新开始，再重置为false
				_aiCompletedNormally = true;
				console.log(LOG_PREFIX + '[Notify] 🏷️square消失，立即标记AI完成(防止误触发)');
				// 关键修复2：自动继续发送"继续"时，square消失是AI暂停，不是完成
				if (_autoContinueSending) {
					console.log(LOG_PREFIX + '[Sound] ⏳square消失但自动继续正在发送，重置完成标志');
					_aiCompletedNormally = false;
					_wasGenerating = false;
					return;
				}
				// 延迟3秒确认（配额banner可能延迟渲染，1.5秒不够）
				if (!_pendingSoundTimer) {
					_pendingSoundTimer = setTimeout(() => {
						// 再次确认square确实消失了
						let stillGone = true;
						const btns2 = document.querySelectorAll('button[type="submit"]');
						for (const btn of btns2) {
							if (btn.querySelector('svg.lucide-square')) { stillGone = false; break; }
						}
						if (!stillGone) {
							// square又出现了，AI重新开始生成，重置完成标志
							_aiCompletedNormally = false;
							console.log(LOG_PREFIX + '[Notify] 🔄square重新出现，重置完成标志');
							_wasGenerating = false;
							_pendingSoundTimer = null;
							return;
						}
						// 配额banner可能延迟渲染，再等1秒二次检查
						const quotaCheck2 = detectQuotaExhausted();
						if (quotaCheck2.detected) {
							// 关键：只有新banner才重置完成标志，允许自动继续
							// 旧banner持续存在于DOM中，不能用它来重置标志
							const bannerText2 = (quotaCheck2.text || '').substring(0, 100);
							const bannerHash2 = 0; // 简单hash
							for (let i = 0; i < bannerText2.length; i++) bannerHash2 = ((bannerHash2 << 5) - bannerHash2 + bannerText2.charCodeAt(i)) | 0;
							if (bannerHash2 !== _lastQuotaBannerHash && bannerHash2 !== 0) {
								console.log(LOG_PREFIX + '[Notify] 🆕检测到新配额banner(hash=' + bannerHash2 + ')，重置完成标志允许自动继续');
								_aiCompletedNormally = false;
								_lastQuotaBannerHash = bannerHash2;
							} else {
								console.log(LOG_PREFIX + '[Notify] ⏳旧配额banner(hash=' + bannerHash2 + ')，保持完成标志');
							}
							_wasGenerating = false;
							_pendingSoundTimer = null;
							return;
						}
						// 再等1秒做最终确认（banner可能很晚才渲染）
						setTimeout(() => {
							const quotaCheck3 = detectQuotaExhausted();
							if (stillGone && !_autoContinueSending) {
								// 标记AI正常完成，防止空闲监控和自动继续误触发
								// 关键修复：即使配额耗尽也要标记完成，否则配额banner存在时
								// _aiCompletedNormally永远为false，守卫不生效导致误触发
								_aiCompletedNormally = true;
								const completedSteps = document.querySelectorAll('[data-step-index]');
								if (completedSteps.length > 0) {
									let maxIdx = 0;
									for (const s of completedSteps) {
										const idx = parseInt(s.getAttribute('data-step-index') || '0');
										if (idx > maxIdx) maxIdx = idx;
									}
									_lastCompletedStepIdx = maxIdx;
								}
								if (!quotaCheck3.detected) {
									console.log(LOG_PREFIX + '[Notify] 检测到AI回复完成');
									notifyEvent('complete');
								} else {
									console.log(LOG_PREFIX + '[Notify] ⏳配额耗尽但AI已完成，标记完成(不发通知)');
								}
								console.log(LOG_PREFIX + '[Notify] ✅已标记AI正常完成(_lastCompletedStepIdx=' + _lastCompletedStepIdx + ')');
							} else if (_autoContinueSending) {
								console.log(LOG_PREFIX + '[Notify] ⏳自动继续发送中，跳过完成通知');
							}
							_wasGenerating = false;
							_pendingSoundTimer = null;
						}, 1000);
					}, 3000);
				}
			}
		};

		_completionActive = true;
		_checkCompletionFn = checkCompletion; // 保存闭包引用
		console.log(LOG_PREFIX + '[Notify] ✅完成检测已启用');
	}

	function onCompletionMutation() {
		if (!_completionActive || !settings.notifySoundEnabled) return;
		clearTimeout(_completionTimer);
		_completionTimer = setTimeout(() => {
			if (_checkCompletionFn) _checkCompletionFn();
		}, 600);
	}

	// ========== AI提问检测 ==========
	// 当AI最后一条消息包含问句或请求用户输入时，触发通知提醒用户
	let _lastQuestionStepIdx = -1; // 防止同一个step重复通知
	let _aiQuestionCheckTimer = 0;

	// AI提问关键词模式（中英文）
	const AI_QUESTION_PATTERNS = [
		// 直接问句
		/\?{2,}/,                          // 多个问号（强调疑问）
		/请问/,                            // 中文"请问"
		/你需要我/,                         // "你需要我..."
		/你希望/,                           // "你希望..."
		/是否需要/,                         // "是否需要..."
		/你想/,                             // "你想..."
		/请提供/,                           // "请提供..."
		/请确认/,                           // "请确认..."
		/请选择/,                           // "请选择..."
		/请告诉我/,                         // "请告诉我..."
		/请输入/,                           // "请输入..."
		/需要你/,                           // "需要你..."
		/需要您/,                           // "需要您..."
		/你想要/,                           // "你想要..."
		/你更倾向/,                         // "你更倾向..."
		/你偏好/,                           // "你偏好..."
		/should i/i,                        // "Should I..."
		/do you want/i,                     // "Do you want..."
		/would you like/i,                  // "Would you like..."
		/which.*would/i,                    // "Which...would..."
		/could you provide/i,               // "Could you provide..."
		/can you tell/i,                    // "Can you tell..."
		/please provide/i,                  // "Please provide..."
		/please confirm/i,                 // "Please confirm..."
		/please specify/i,                  // "Please specify..."
		/please choose/i,                   // "Please choose..."
		/please enter/i,                    // "Please enter..."
		/i need (your|you)/i,              // "I need your..."
		/what (would|should|do) you/i,      // "What would/should/do you..."
		/how would you/i,                   // "How would you..."
		/let me know/i,                     // "Let me know..."
		/waiting for (your|you|input)/i,    // "Waiting for your..."
	];

	// 检测AI最后一条消息是否在提问
	function detectAiQuestion() {
		if (!settings.notifyOnAiQuestion) return;
		const allSteps = document.querySelectorAll('[data-step-index]');
		if (allSteps.length === 0) return;

		// 找最大step-index
		let lastStep = null, maxIdx = -1;
		for (const s of allSteps) {
			const idx = parseInt(s.getAttribute('data-step-index') || '0');
			if (idx > maxIdx) { maxIdx = idx; lastStep = s; }
		}
		if (!lastStep) return;

		// 防重复：同一个step不重复检测
		if (maxIdx <= _lastQuestionStepIdx) return;

		const stepText = cleanText(lastStep.textContent || '');
		// 排除配额耗尽的step（不需要用户输入，需要自动继续）
		if (EXHAUST_KEYWORDS.some(kw => stepText.includes(kw))) return;

		// 检查是否包含问句模式
		const isQuestion = AI_QUESTION_PATTERNS.some(p => p.test(stepText));

		// 也检测末尾是否以问号结束（简单但有效）
		const lastChar = stepText.trim().slice(-1);
		const endsWithQuestion = lastChar === '?' || lastChar === '？';

		if (isQuestion || endsWithQuestion) {
			_lastQuestionStepIdx = maxIdx;
			// 提取问句摘要（取最后200字）
			const summary = stepText.slice(-200);
			console.log(LOG_PREFIX + '[AiQuestion] ❓检测到AI提问(step=' + maxIdx + '): "' + summary.substring(0, 80) + '..."');
			notifyEvent('aiQuestion', summary.substring(0, 100));
		}
	}

	// ========== 辅助函数：查找最后一个AI文本步骤 ==========
	// 区分AI文本步骤和工具/命令/思考步骤：
	// - AI文本步骤：包含 .prose 类（AI回复的富文本容器），且不是思考步骤
	// - 思考步骤：包含"思考"/"Thought"标题 + "耗时"时间（不是AI的实际回复）
	// - 工具/命令步骤：包含 .panel-bg/.shadow-step（命令面板），或 terminal 图标
	// 返回 { el, idx, text } 或 null
	function findLastAiTextStep() {
		const allSteps = document.querySelectorAll('[data-step-index]');
		if (allSteps.length === 0) return null;
		// 从后往前找第一个包含prose的step（=AI文本回复）
		const stepArr = Array.from(allSteps).map(s => ({
			el: s,
			idx: parseInt(s.getAttribute('data-step-index') || '0')
		})).sort((a, b) => b.idx - a.idx);
		for (const s of stepArr) {
			// AI文本步骤包含 .prose 类元素
			if (s.el.querySelector('.prose, [class*="prose"]')) {
				// 排除用户输入步骤
				const hasUserMarker = s.el.querySelector('[class*="user-message"], [class*="user_input"], [class*="self-end"]');
				if (hasUserMarker) continue;
				// 排除思考步骤：思考步骤的文本以"思考"开头且很短（只有"思考耗时 X 秒"）
				const txt = cleanText(s.el.textContent || '');
				if ((txt.startsWith('思考') || txt.startsWith('thought')) && txt.length < 50) continue;
				return { el: s.el, idx: s.idx, text: txt };
			}
		}
		// 如果没找到prose，从后往前找非命令/非思考步骤
		for (const s of stepArr) {
			const isCommandStep = s.el.querySelector('.panel-bg, .shadow-step, svg.lucide-terminal, [class*="command"]');
			const txt = cleanText(s.el.textContent || '');
			const isThinkingStep = (txt.startsWith('思考') || txt.startsWith('thought')) && txt.length < 50;
			if (!isCommandStep && !isThinkingStep) {
				return { el: s.el, idx: s.idx, text: txt };
			}
		}
		return null;
	}

	// ========== 长时间等待自动继续 ==========
	// 当AI停止生成（square消失）且无配额耗尽、无提问时，
	// 可能是命令在后台运行导致AI等待，超时后自动发送"继续"
	let _idleSince = 0;           // AI空闲起始时间
	let _idleCheckTimer = null;   // 空闲检查定时器
	let _lastIdleStepCount = 0;   // 上次空闲时的step数量
	const IDLE_CONTINUE_THRESHOLD = 60000; // 60秒空闲后自动继续
	const IDLE_CHECK_INTERVAL = 15000;     // 每15秒检查一次

	function startIdleContinueMonitor() {
		if (_idleCheckTimer) return;
		_idleCheckTimer = setInterval(() => {
			if (!settings.autoContinueEnabled) return;
			if (window.__wsStopAutoContinue) return;
			if (_autoContinueSending || _quotaContinueCooldown) return;

			// 检查AI是否正在生成（square图标）
			let isGenerating = false;
			for (const btn of document.querySelectorAll('button[type="submit"]')) {
				const rect = btn.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				if (btn.querySelector('svg.lucide-square')) { isGenerating = true; break; }
			}

			const now = Date.now();
			if (isGenerating) {
				// AI正在生成，重置空闲计时
				_idleSince = 0;
				_lastIdleStepCount = 0;
				return;
			}

			// AI不在生成
			// 检查是否有配额耗尽（交给现有机制处理）
			const quotaResult = detectQuotaExhausted();
			if (quotaResult.detected) {
				_idleSince = 0;
				return;
			}

			// 检查用户是否正在输入
			const inputEl = findInputEl();
			if (inputEl) {
				const inputText = (inputEl.textContent || inputEl.value || '').replace(/\u200B/g, '').trim();
				if (inputText.length > 0 && inputText !== '继续') {
					_idleSince = 0;
					return;
				}
			}

			// 检查是否有"Continue response"按钮（交给现有机制处理）
			const btns = document.querySelectorAll('button, [role="button"]');
			for (const btn of btns) {
				const txt = (btn.textContent || '').trim();
				if (txt === 'Continue response' || txt === '继续回复') {
					_idleSince = 0;
					return; // 交给现有截断检测
				}
			}

			// 检查是否有step（无step说明还没开始对话）
			const allSteps = document.querySelectorAll('[data-step-index]');
			if (allSteps.length === 0) {
				_idleSince = 0;
				return;
			}

			// ★核心修复：如果AI已正常完成（完成通知系统确认），不触发空闲继续
			// 检查是否有新的step出现（用户发了新消息），如果有则重置完成标志
			let currentMaxStepIdx = 0;
			for (const s of allSteps) {
				const idx = parseInt(s.getAttribute('data-step-index') || '0');
				if (idx > currentMaxStepIdx) currentMaxStepIdx = idx;
			}
			if (_aiCompletedNormally && currentMaxStepIdx > _lastCompletedStepIdx) {
				// 有新的step出现，说明用户发了新消息或AI开始新回复，重置标志
				console.log(LOG_PREFIX + '[IdleContinue] 🔄检测到新step(' + currentMaxStepIdx + '>' + _lastCompletedStepIdx + ')，重置完成标志');
				_aiCompletedNormally = false;
				_lastCompletedStepIdx = -1;
			}
			if (_aiCompletedNormally) {
				if (_idleSince !== 0) {
					console.log(LOG_PREFIX + '[IdleContinue] ✅AI已正常完成(完成通知确认)，重置空闲计时');
				}
				_idleSince = 0;
				return;
			}

			// 关键修复：查找最后一个AI文本步骤（而非命令步骤）
			// 命令步骤如"已检查命令状态"不以正常标点结尾，导致误判
			const lastAiStep = findLastAiTextStep();
			if (lastAiStep) {
				const stepText = lastAiStep.text;
				const isQuestion = AI_QUESTION_PATTERNS.some(p => p.test(stepText));
				const lastChar = stepText.trim().slice(-1);
				if (isQuestion || lastChar === '?' || lastChar === '？') {
					_idleSince = 0;
					return; // AI在提问，不自动继续
				}
				// 检查AI回复是否正常结束（末尾有正常标点）
				const normalEndings = ['.', '。', '！', '？', '!', '?', ':', '：', ')', '）', ']', '】', '`', '"', "'", ';', '；', '—', '…', '}', '>', '|', '/', '%', '~', '^', '+', '=', '#', '@', '&', '*'];
				const endsNormally = normalEndings.some(e => stepText.trim().endsWith(e));
				// 代码块结尾检测 (```或~~~)
				const endsWithCodeBlock = /```[\s`]*$/.test(stepText.trim().slice(-10)) || /~~~[\s~]*$/.test(stepText.trim().slice(-10));
				// Markdown标题/列表结尾
				const endsWithMarkdown = /^[#\-*]/m.test(stepText.trim().slice(-30));
				// 完成短语检测
				const COMPLETION_PHRASES = [
					/task complete/i, /task completed/i, /all done/i, /finished/i,
					/已完成/, /任务完成/, /全部完成/, /操作完成/, /修改完成/, /创建完成/, /删除完成/,
					/已成功/, /成功创建/, /成功修改/, /成功删除/, /已应用/,
					/that.s it/i, /here you go/i, /hope this helps/i,
					/完成$/, /完成了$/, /已完毕/, /完毕/,
					/总结/, /summary/i, /in conclusion/i,
				];
				const hasCompletionPhrase = COMPLETION_PHRASES.some(p => p.test(stepText.slice(-80)));
				// 长文本默认视为完成（AI写了很长内容大概率是完整回复）
				const isLongResponse = stepText.length > 500;
				if ((endsNormally && stepText.length > 20) || endsWithCodeBlock || hasCompletionPhrase || isLongResponse) {
					if (_idleSince !== 0) {
						console.log(LOG_PREFIX + '[IdleContinue] ✅AI文本步骤正常结束(step=' + lastAiStep.idx + ', 末尾="' + stepText.trim().slice(-3) + '", completionPhrase=' + hasCompletionPhrase + ')，重置空闲计时');
					}
					_idleSince = 0;
					return;
				}
				console.log(LOG_PREFIX + '[IdleContinue] 🔍AI文本步骤(step=' + lastAiStep.idx + ')末尾="' + stepText.trim().slice(-10) + '", endsNormally=' + endsNormally);
			} else {
				// 没找到AI文本步骤，只有命令步骤 — AI可能已完成
				console.log(LOG_PREFIX + '[IdleContinue] 🔍未找到AI文本步骤(只有命令步骤)，AI可能已完成');
				_idleSince = 0;
				return;
			}

			// 开始/累积空闲计时
			if (_idleSince === 0) {
				_idleSince = now;
				_lastIdleStepCount = allSteps.length;
				console.log(LOG_PREFIX + '[IdleContinue] ⏱️AI空闲开始计时');
			}

			const idleDuration = now - _idleSince;
			if (idleDuration >= IDLE_CONTINUE_THRESHOLD) {
				// 超过阈值，检查step数量是否没变化（确认是真的空闲）
				if (allSteps.length === _lastIdleStepCount) {
					// 关键守卫：如果AI正在生成中（square图标），不需要发"继续"
					const submitBtn2 = document.querySelector('button[type="submit"]');
					if (submitBtn2 && submitBtn2.querySelector('svg.lucide-square')) {
						console.log(LOG_PREFIX + '[IdleContinue] ❌AI正在生成中(square图标)，不需要发送"继续"');
						_idleSince = 0;
						return;
					}
					// 关键守卫：如果配额真正耗尽，不发送
					if (isQuotaTrulyExhausted()) {
						console.log(LOG_PREFIX + '[IdleContinue] 🚫配额真正耗尽，放弃空闲继续');
						_idleSince = 0;
						return;
					}
					console.error(LOG_PREFIX + '🔴路径3触发: IdleContinue空闲' + Math.round(idleDuration / 1000) + '秒，即将发送"继续"');
					console.trace(LOG_PREFIX + '路径3调用栈');
					notifyEvent('autoContinue', 'AI长时间空闲，正在自动发送"继续"...');
					// 使用现有的发送机制
					_autoContinueSending = true;
					const ok = setInputText('继续');
					if (!ok) {
						console.log(LOG_PREFIX + '[IdleContinue] 找不到输入框，放弃');
						_autoContinueSending = false;
						_idleSince = 0;
						return;
					}
					// 点击发送
					setTimeout(() => {
						for (const btn of document.querySelectorAll('button[type="submit"]')) {
							const rect = btn.getBoundingClientRect();
							if (rect.width === 0 || rect.height === 0) continue;
							const arrowSvg = btn.querySelector('svg.lucide-arrow-up');
							if (!arrowSvg) continue;
							if (btn.classList.contains('cursor-not-allowed') || btn.classList.contains('opacity-50')) continue;
							btn.click();
							console.log(LOG_PREFIX + '[IdleContinue] 📤已点击submit按钮');
							break;
						}
					}, 300);
					// 验证发送
					setTimeout(() => {
						const inputEl2 = findInputEl();
						if (inputEl2) {
							const textAfter = (inputEl2.textContent || inputEl2.value || '').replace(/\u200B/g, '').trim();
							if (textAfter === '继续') {
								console.log(LOG_PREFIX + '[IdleContinue] ❌空闲继续发送失败');
							} else {
								console.log(LOG_PREFIX + '[IdleContinue] ✅空闲继续发送成功');
							}
						}
						_autoContinueSending = false;
						_idleSince = 0;
						// 冷却30秒
						_quotaContinueCooldown = true;
						setTimeout(() => { _quotaContinueCooldown = false; }, 30000);
					}, 1000);
				} else {
					// step数量变了，AI可能已经开始新回复，重置
					_idleSince = 0;
					_lastIdleStepCount = allSteps.length;
				}
			} else {
				console.log(LOG_PREFIX + '[IdleContinue] ⏳AI已空闲' + Math.round(idleDuration / 1000) + '秒/' + Math.round(IDLE_CONTINUE_THRESHOLD / 1000) + '秒');
			}
		}, IDLE_CHECK_INTERVAL);
		console.log(LOG_PREFIX + '[IdleContinue] ✅空闲继续监控已启动(阈值=' + Math.round(IDLE_CONTINUE_THRESHOLD / 1000) + '秒)');
	}

	// ========== 配额余额检查 ==========
	// 在自动继续发送"继续"之前，检查是否真的还有余额
	// 用户选择：即使banner说"购买额外使用量"也尝试发送"继续"（可能切换到免费模型继续）
	// 只有在完全无法使用时才放弃（连续3次发送"继续"无回复由失败计数器处理）
	// 所以QUOTA_LOW_KEYWORDS只保留"完全无法使用"的极端信号
	const QUOTA_LOW_KEYWORDS = [
		// 完全无法使用的信号（极少出现）
		'no remaining quota',
		'no credits remaining',
		'account suspended',
		'账户已暂停',
		'service unavailable',
		'service temporarily unavailable',
	];

	// 检测配额是否真的耗尽（无余额可继续）
	// 与detectQuotaExhausted()不同，此函数用于判断是否应该放弃自动继续
	function isQuotaTrulyExhausted() {
		const quotaResult = detectQuotaExhausted();
		if (!quotaResult.detected) return false;

		// 检查banner/step文本中是否包含"完全无法使用"的极端信号
		// 普通的"购买额外使用量"不算，因为可能切换到免费模型继续
		const text = quotaResult.text || '';
		const isTrulyExhausted = QUOTA_LOW_KEYWORDS.some(kw => text.includes(kw));

		if (isTrulyExhausted) {
			console.log(LOG_PREFIX + '[QuotaCheck] 🚫配额真正耗尽，不应继续发送: "' + text.substring(0, 80) + '"');
			return true;
		}

		// 检查是否有"Continue response"按钮 — 如果有，说明还有余额
		const btns = document.querySelectorAll('button, [role="button"]');
		for (const btn of btns) {
			const txt = (btn.textContent || '').trim();
			if (txt === 'Continue response' || txt === '继续回复') {
				console.log(LOG_PREFIX + '[QuotaCheck] ✅有"Continue response"按钮，余额可能还有');
				return false;
			}
		}

		// 检查submit按钮是否可用（可点击=可能有余额）
		for (const btn of document.querySelectorAll('button[type="submit"]')) {
			const rect = btn.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) continue;
			if (!btn.classList.contains('cursor-not-allowed') && !btn.classList.contains('opacity-50')) {
				if (btn.querySelector('svg.lucide-arrow-up')) {
					console.log(LOG_PREFIX + '[QuotaCheck] ✅submit按钮可用，余额可能还有');
					return false;
				}
			}
		}

		// 默认：配额耗尽但不确定是否有余额，允许尝试一次
		console.log(LOG_PREFIX + '[QuotaCheck] ⚠️配额耗尽但无法确定余额，允许尝试一次');
		return false;
	}

	function dismissCorruptWarning() {
		const kw = ['corrupt', 'reinstall', '损坏', '重新安装'];
		function tryD() {
			document.querySelectorAll('.notification-toast,.notifications-toasts .notification-list-item').forEach(t => {
				const x = (t.textContent || '').toLowerCase();
				if (kw.some(k => x.includes(k))) {
					const c = t.querySelector('.codicon-notifications-clear,.codicon-close,.action-label[title*="Close"],.action-label[title*="关闭"]');
					if (c) { c.click(); logLocalization('✅关闭损坏通知'); }
					else { t.style.display = 'none'; logLocalization('✅隐藏损坏通知'); }
				}
			});
		}
		const obs = new MutationObserver(() => tryD());
		obs.observe(document.body, { childList: true, subtree: true });
		setTimeout(() => obs.disconnect(), 30000);
		setTimeout(tryD, 2000);
	}
	
	// ========== 配额耗尽实时监听 ==========
	// 用MutationObserver实时监听DOM，捕获配额banner出现
	// 比定时轮询更可靠，能在banner出现的瞬间就检测到
	let _quotaBannerObserver = null;
	let _lastQuotaBannerTime = 0; // 上次检测到banner的时间
	function startQuotaBannerObserver() {
		if (_quotaBannerObserver) return;
		// 检查元素是否包含配额关键词
		function checkElForQuota(el) {
			if (!el || !el.querySelectorAll) return false;
			const txt = cleanText(el.textContent || '');
			return EXHAUST_KEYWORDS.some(kw => txt.includes(kw));
		}
		// 递归检查新增节点
		function checkAddedNodes(nodes) {
			for (const node of nodes) {
				if (node.nodeType !== Node.ELEMENT_NODE) continue;
				// 检查元素本身
				if (checkElForQuota(node)) {
					const now = Date.now();
					if (now - _lastQuotaBannerTime < 5000) return; // 5秒内不重复
					_lastQuotaBannerTime = now;
					const txt = cleanText(node.textContent || '');
					console.log(LOG_PREFIX + '[QuotaObserver] 🎯MutationObserver检测到配额耗尽: "' + txt.substring(0, 80) + '..." (tag=' + node.tagName + ', class=' + (node.className || '').toString().substring(0, 60) + ')');
					// 触发自动继续
					if (settings.autoContinueEnabled && !_autoContinueSending && !_quotaContinueCooldown) {
						// 延迟1秒让DOM稳定
						setTimeout(() => {
							if (_tryClickFn) _tryClickFn();
						}, 1000);
					}
					return;
				}
				// 检查子元素
				const children = node.querySelectorAll ? node.querySelectorAll('div, p, span') : [];
				for (const child of children) {
					if (checkElForQuota(child)) {
						const now = Date.now();
						if (now - _lastQuotaBannerTime < 5000) return;
						_lastQuotaBannerTime = now;
						const txt = cleanText(child.textContent || '');
						console.log(LOG_PREFIX + '[QuotaObserver] 🎯MutationObserver检测到配额耗尽(子元素): "' + txt.substring(0, 80) + '..." (tag=' + child.tagName + ', class=' + (child.className || '').toString().substring(0, 60) + ')');
						if (settings.autoContinueEnabled && !_autoContinueSending && !_quotaContinueCooldown) {
							setTimeout(() => {
								if (_tryClickFn) _tryClickFn();
							}, 1000);
						}
						return;
					}
				}
			}
		}
		_quotaBannerObserver = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.addedNodes.length > 0) {
					checkAddedNodes(m.addedNodes);
				}
				// 也检查属性变化（某些banner通过class切换显示）
				if (m.type === 'attributes' && m.target.nodeType === Node.ELEMENT_NODE) {
					const el = m.target;
					const txt = cleanText(el.textContent || '');
					if (EXHAUST_KEYWORDS.some(kw => txt.includes(kw))) {
						const now = Date.now();
						if (now - _lastQuotaBannerTime < 5000) return;
						_lastQuotaBannerTime = now;
						console.log(LOG_PREFIX + '[QuotaObserver] 🎯属性变化检测到配额耗尽: "' + txt.substring(0, 80) + '..."');
						if (settings.autoContinueEnabled && !_autoContinueSending && !_quotaContinueCooldown) {
							setTimeout(() => {
								if (_tryClickFn) _tryClickFn();
							}, 1000);
						}
					}
				}
			}
		});
		// 监听整个document，包括子树变化
		_quotaBannerObserver.observe(document.body || document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['class', 'style']
		});
		console.log(LOG_PREFIX + '[QuotaObserver] ✅配额banner MutationObserver已启动');
	}

	// ========== 浮动设置面板 ==========
	function injectFloatingSettings() {
		// 避免重复注入
		if (document.getElementById('ws-better-float-btn')) {
			console.log(LOG_PREFIX + '[FloatSettings] 按钮已存在，跳过');
			return;
		}

		// 等待body可用
		const body = document.body || document.documentElement;
		if (!body) {
			console.log(LOG_PREFIX + '[FloatSettings] ⏳body不可用，1秒后重试');
			setTimeout(injectFloatingSettings, 1000);
			return;
		}

		console.log(LOG_PREFIX + '[FloatSettings] 开始注入浮动按钮...');

		const style = document.createElement('style');
		style.textContent = `
			#ws-better-float-btn {
				position: fixed !important; bottom: 60px !important; right: 16px !important; z-index: 99999 !important;
				width: 36px !important; height: 36px !important; border-radius: 50% !important; border: none !important;
				background: #0e639c !important; color: #fff !important; font-size: 16px !important; cursor: pointer !important;
				box-shadow: 0 2px 8px rgba(0,0,0,.3) !important; display: flex !important; align-items: center !important;
				justify-content: center !important; transition: transform .15s, background .15s !important;
				pointer-events: auto !important; visibility: visible !important; opacity: 1 !important;
			}
			#ws-better-float-btn:hover { background: #1177bb !important; transform: scale(1.1) !important; }
			#ws-better-float-panel {
				position: fixed !important; bottom: 104px !important; right: 16px !important; z-index: 99999 !important;
				background: #1e1e2e !important; color: #ccc !important; border: 1px solid #333 !important;
				border-radius: 8px !important; padding: 12px 14px !important; width: 220px !important;
				font-size: 12px !important; font-family: -apple-system, sans-serif !important;
				box-shadow: 0 4px 16px rgba(0,0,0,.4) !important; display: none !important;
				pointer-events: auto !important;
			}
			#ws-better-float-panel.show { display: block !important; }
			#ws-better-float-panel h3 { margin: 0 0 8px !important; font-size: 13px !important; color: #fff !important; }
			#ws-better-float-panel .row { display: flex !important; justify-content: space-between !important; align-items: center !important; padding: 3px 0 !important; }
			#ws-better-float-panel label { font-size: 11px !important; color: #aaa !important; }
			#ws-better-float-panel .sw { position: relative !important; width: 28px !important; height: 16px !important; flex-shrink: 0 !important; }
			#ws-better-float-panel .sw input { opacity: 0 !important; width: 0 !important; height: 0 !important; }
			#ws-better-float-panel .sw .sl { position: absolute !important; cursor: pointer !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
				background: #444 !important; border-radius: 8px !important; transition: .2s !important; }
			#ws-better-float-panel .sw .sl:before { position: absolute !important; content: "" !important; height: 12px !important; width: 12px !important;
				left: 2px !important; bottom: 2px !important; background: #888 !important; border-radius: 50% !important; transition: .2s !important; }
			#ws-better-float-panel .sw input:checked+.sl { background: #0e639c !important; }
			#ws-better-float-panel .sw input:checked+.sl:before { transform: translateX(12px) !important; background: #fff !important; }
			#ws-better-float-panel .ver { font-size: 10px !important; color: #666 !important; text-align: center !important; margin-top: 8px !important; }
		`;
		(document.head || document.documentElement).appendChild(style);

		// 浮动按钮
		const btn = document.createElement('button');
		btn.id = 'ws-better-float-btn';
		btn.textContent = '⚡';
		btn.title = 'Windsurf Better v' + VERSION;
		body.appendChild(btn);

		// 设置面板
		const panel = document.createElement('div');
		panel.id = 'ws-better-float-panel';
		const toggles = [
			['autoContinueEnabled', '自动继续'],
			['localizationEnabled', '界面汉化'],
			['bubblesEnabled', '气泡提示'],
			['notifySoundEnabled', '提示音'],
			['chatQueueEnabled', '对话队列'],
		];
		let html = '<h3>Windsurf Better</h3>';
		for (const [key, label] of toggles) {
			html += '<div class="row"><label>' + label + '</label><label class="sw"><input type="checkbox" data-key="' + key + '"' + (settings[key] ? ' checked' : '') + '><span class="sl"></span></label></div>';
		}
		html += '<div class="ver">v' + VERSION + '</div>';
		try {
			const policy = getTTPolicy();
			panel.innerHTML = policy ? policy.createHTML(html) : html;
		} catch(e) {
			console.error(LOG_PREFIX + '[FloatSettings] innerHTML失败:', e);
			panel.innerHTML = html;
		}
		body.appendChild(panel);

		// 切换面板显示
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			panel.classList.toggle('show');
		});

		// 设置变更
		panel.querySelectorAll('input[data-key]').forEach(input => {
			input.addEventListener('change', () => {
				const key = input.dataset.key;
				settings[key] = input.checked;
				localStorage.setItem('ws-better-settings', JSON.stringify(settings));
				console.log(LOG_PREFIX + '[Settings] ' + key + ' = ' + input.checked);
			});
		});

		// 点击面板外关闭
		document.addEventListener('click', (e) => {
			if (!panel.contains(e.target) && e.target !== btn) {
				panel.classList.remove('show');
			}
		});

		console.log(LOG_PREFIX + '[FloatSettings] ✅浮动设置按钮已注入(body=' + (document.body ? 'ok' : 'null') + ')');
	}

	// ========== 初始化 ==========
	function init() {
		console.log('🚀 Windsurf Better v' + VERSION + ' 初始化');
		window.__wsBetterVersion = VERSION; // 全局标记，方便排查

		// 启动时清除所有旧的 ws-quota-handled-* 键
		// 这些键可能是之前发送失败时设置的，会阻止自动继续重试
		try {
			const toRemove = [];
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k && k.startsWith('ws-quota-handled-')) toRemove.push(k);
			}
			if (toRemove.length > 0) {
				for (const k of toRemove) localStorage.removeItem(k);
				console.log(LOG_PREFIX + '[Init] 清除了' + toRemove.length + '个旧的quota-handled键');
			}
		} catch (e) { console.log(LOG_PREFIX + '[Init] 清理handledKey异常:', e.message); }

		// 设置UI已迁移到Extension侧边栏，不再在此创建
		// 注入气泡样式（之前由createSettingsUI调用，现在独立调用）
		try { injectBubblesStyles(); } catch (e) { console.error(LOG_PREFIX + '[Init] injectBubblesStyles失败:', e); }

		// 注入浮动设置按钮（不依赖Extension面板，直接在聊天区域显示）
		try { injectFloatingSettings(); } catch (e) { console.error(LOG_PREFIX + '[Init] injectFloatingSettings失败:', e); }

		try {
			dismissCorruptWarning();
		} catch (e) { console.error(LOG_PREFIX + '[Init] ❌dismissCorruptWarning失败:', e); }

		// 启动统一观察器（替代5个独立观察器）
		startUnifiedObserver();

		if (settings.autoContinueEnabled) { startAutoContinue(); startIdleContinueMonitor(); startQuotaBannerObserver(); startInputGuard(); startSubmitInterceptor(); }
		if (settings.notifySoundEnabled) startNotificationSound();
		if (settings.chatQueueEnabled) startChatQueueObserver();
		
		// 启动气泡功能
		if (settings.bubblesEnabled) {
			const tryStartBubbles = () => {
				const root = findChatRoot();
				if (root) {
					logBubbles('✅聊天面板已就绪');
					startBubblesObserving();
				} else {
					const obs = new MutationObserver((_, o) => {
						const r = findChatRoot();
						if (r) {
							o.disconnect();
							logBubbles('✅聊天面板已就绪(延迟)');
							startBubblesObserving();
						}
					});
					obs.observe(document.body, { childList: true, subtree: true });
					// 30秒后如果还没找到聊天面板，断开观察器避免泄漏
					setTimeout(() => { if (obs) obs.disconnect(); }, 30000);
					logBubbles('⏳等待聊天面板...');
				}
			};
			if (document.readyState === 'complete') setTimeout(tryStartBubbles, 1000);
			else window.addEventListener('load', () => setTimeout(tryStartBubbles, 1000));
		}
		
		// 启动汉化功能
		if (settings.localizationEnabled) {
			startLocalizationObserver();
			enqueue(document.body);
			logLocalization('✅汉化已启用');
		}
	}
	
	if (document.readyState === 'loading') {
	// 强制每3秒全量重扫一次，覆盖延迟渲染的页面
	setInterval(() => {
		if (settings.localizationEnabled) {
			_isTranslating = false;
			enqueue(document.body);
		}
	}, 3000);
		window.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
	} else {
		setTimeout(init, 800);
	}
})();