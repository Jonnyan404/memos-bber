const UI_LANGUAGE_STORAGE_KEY = 'uiLanguage'

const SUPPORTED_UI_LANGUAGES = new Set(['auto', 'en', 'zh_CN', 'ja', 'ko', 'de'])

function normalizeUiLanguage(value) {
	const lang = String(value || 'auto')
	return SUPPORTED_UI_LANGUAGES.has(lang) ? lang : 'auto'
}

function storageSyncGet(defaults) {
	return new Promise((resolve) => {
		chrome.storage.sync.get(defaults, (items) => resolve(items || {}))
	})
}

function storageSyncSet(items) {
	return new Promise((resolve) => {
		chrome.storage.sync.set(items, () => resolve())
	})
}

async function loadLocaleMessages(locale) {
	if (!locale || locale === 'auto') return null
	try {
		const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`)
		const resp = await fetch(url)
		if (!resp.ok) return null
		return await resp.json()
	} catch (_) {
		return null
	}
}

function formatSubstitutions(message, substitutions) {
	if (!message) return ''
	if (substitutions == null) return message
	const subs = Array.isArray(substitutions) ? substitutions : [substitutions]
	let out = message
	for (let i = 0; i < subs.length; i++) {
		const v = String(subs[i])
		out = out.replaceAll(`$${i + 1}`, v)
		out = out.replace('%s', v)
	}
	return out
}

let currentUiLanguage = 'auto'
let overrideMessages = null

function getLanguageToggleLabel(lang) {
	if (lang === 'en') return 'EN'
	if (lang === 'zh_CN') return '中'
	if (lang === 'ja') return '日'
	if (lang === 'ko') return '한'
	if (lang === 'de') return 'DE'
	return 'A'
}

function syncLanguageToggleText(lang) {
	const text = document.getElementById('langToggleText')
	if (text) text.textContent = getLanguageToggleLabel(lang)
}

function syncLanguageMenuState(lang) {
	const items = document.querySelectorAll('.lang-menu-item')
	items.forEach((item) => {
		const isActive = item.getAttribute('data-lang') === lang
		item.classList.toggle('active', isActive)
		item.setAttribute('aria-checked', isActive ? 'true' : 'false')
	})
}

function setLanguageMenuOpen(isOpen) {
	const toggle = document.getElementById('langToggle')
	const menu = document.getElementById('langMenu')
	if (!toggle || !menu) return
	toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
	menu.classList.toggle('hidden', !isOpen)
}

function t(key, substitutions) {
	const msg = overrideMessages && overrideMessages[key] && overrideMessages[key].message
	if (typeof msg === 'string' && msg.length > 0) {
		return formatSubstitutions(msg, substitutions)
	}
	const chromeMsg = chrome.i18n.getMessage(key, substitutions) || ''
	return formatSubstitutions(chromeMsg, substitutions)
}

function setText(id, messageKey) {
	const el = document.getElementById(id)
	if (el) el.textContent = t(messageKey)
}

function setPlaceholder(id, messageKey) {
	const el = document.getElementById(id)
	if (el) el.placeholder = t(messageKey)
}

function setTitle(id, messageKey) {
	const el = document.getElementById(id)
	if (el) el.title = t(messageKey)
}

function applyStaticI18n() {
	setText('saveSettings', 'saveBtn')
	setText('saveTag', 'saveBtn')

	setText('supportedMemosVersion', 'supportedMemosVersion')
	setText('settingsConnectionTitle', 'settingsConnectionTitle')
	setText('settingsConnectionDesc', 'settingsConnectionDesc')
	setText('settingsPostingTitle', 'settingsPostingTitle')
	setText('settingsPostingDesc', 'settingsPostingDesc')

	setPlaceholder('apiUrl', 'placeApiUrl')
	setPlaceholder('apiTokens', 'placeApiTokens')
	setPlaceholder('content', 'placeContent')

	setText('lockPrivate', 'lockPrivate')
	setText('lockProtected', 'lockProtected')
	setText('lockPublic', 'lockPublic')

	setText('content_submit_text', 'submitBtn')
	const fullscreen = document.getElementById('fullscreen')
	if (fullscreen) fullscreen.setAttribute('aria-label', t('tipFullscreen'))

	setPlaceholder('hideInput', 'placeHideInput')
	setPlaceholder('showInput', 'placeShowInput')
	setPlaceholder('attachmentOnlyDefaultText', 'placeAttachmentOnlyDefaultText')

	setText('uploadlist-title', 'uploadedListTitle')

	// Language switcher
	setText('langOptionAuto', 'langAuto')
	setText('langOptionEn', 'langEnglish')
	setText('langOptionZhCN', 'langChineseSimplified')
	setText('langOptionJa', 'langJapanese')
	setText('langOptionKo', 'langKorean')
	setText('langOptionDe', 'langGerman')
	setTitle('langToggle', 'tipLanguage')
	const langToggle = document.getElementById('langToggle')
	if (langToggle) langToggle.setAttribute('aria-label', t('tipLanguage'))

	// Native hover tooltips (title)
	setTitle('opensite', 'tipOpenSite')
	setTitle('blog_info_edit', 'tipSettings')
	setTitle('tags', 'tipTags')
	setTitle('newtodo', 'tipTodo')
	setTitle('upres', 'tipUpload')
	setTitle('getlink', 'tipLink')
	setTitle('random', 'tipRandom')
	setTitle('search', 'tipSearch')
	setTitle('lock', 'tipVisibility')
	setTitle('content_submit_text', 'tipSend')
	setTitle('fullscreen', 'tipFullscreen')
	setTitle('editor-resize-handle', 'tipResize')
}

async function setUiLanguage(nextLang, { persist = true } = {}) {
	const lang = normalizeUiLanguage(nextLang)
	currentUiLanguage = lang
	overrideMessages = await loadLocaleMessages(lang)
	applyStaticI18n()
	syncLanguageToggleText(lang)
	syncLanguageMenuState(lang)

	if (persist) await storageSyncSet({ [UI_LANGUAGE_STORAGE_KEY]: lang })
	window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }))
}

async function initLanguageSwitcher() {
	const switcher = document.getElementById('lang_switcher')
	const toggle = document.getElementById('langToggle')
	const langItems = document.querySelectorAll('.lang-menu-item')

	if (toggle) {
		toggle.addEventListener('click', (event) => {
			event.stopPropagation()
			const isOpen = toggle.getAttribute('aria-expanded') === 'true'
			setLanguageMenuOpen(!isOpen)
		})
	}

	langItems.forEach((item) => {
		item.addEventListener('click', async (event) => {
			event.stopPropagation()
			setLanguageMenuOpen(false)
			await setUiLanguage(item.getAttribute('data-lang'))
		})
	})

	document.addEventListener('click', (event) => {
		if (!switcher || switcher.contains(event.target)) return
		setLanguageMenuOpen(false)
	})

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') setLanguageMenuOpen(false)
	})

	const storedItems = await storageSyncGet({ [UI_LANGUAGE_STORAGE_KEY]: 'auto' })
	const stored = normalizeUiLanguage(storedItems[UI_LANGUAGE_STORAGE_KEY])
	await setUiLanguage(stored, { persist: false })
	setLanguageMenuOpen(false)
}

window.t = t
window.setUiLanguage = setUiLanguage
window.getUiLanguage = () => currentUiLanguage

applyStaticI18n()
window.i18nReady = initLanguageSwitcher()