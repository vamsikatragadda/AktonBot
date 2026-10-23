import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { ABOUT_CSS } from '../../../akton-bot/src/client/about.js'
import { BOT_SETTINGS_CSS } from '../../../akton-bot/src/client/bot-settings.js'
import { FEEDBACK_CSS } from '../../../akton-bot/src/client/feedback.js'
import { FOLDER_CSS } from '../../../akton-bot/src/client/folder-menu.js'
import { GROUP_SETTINGS_CSS } from '../../../akton-bot/src/client/group-settings.js'
import { installLocale } from '../../../akton-bot/src/client/i18n.js'
import { MEMBER_CSS } from '../../../akton-bot/src/client/member-status.js'
import { MODEL_CSS } from '../../../akton-bot/src/client/model-menu.js'
import { PROVIDERS_CSS } from '../../../akton-bot/src/client/providers-page.js'
import { SCHEDULE_CSS } from '../../../akton-bot/src/client/schedules.js'
import { SECRET_CSS } from '../../../akton-bot/src/client/secret-card.js'
import { SIDEBAR_CSS } from '../../../akton-bot/src/client/sidebar.js'
import { CONVERSATION_CSS, SHELL_CSS, installStyles } from '../../../akton-bot/src/client/styles.js'
import { USAGE_CSS } from '../../../akton-bot/src/client/usage-page.js'
import { createLocale } from './locale.js'
import { App } from './app.js'
import './app.css'

installLocale(createLocale(navigator.language))
document.documentElement.lang = navigator.language
// macOS puts the window buttons at the band's left end, over the sidebar (app.css).
if (/mac/iu.test(navigator.userAgentData?.platform ?? navigator.platform)) document.documentElement.dataset.mac = ''

// The Bot views' own stylesheets, the same ones the plugin puts in DSH.
for (const [tag, text] of [
  ['shell', SHELL_CSS], ['sidebar', SIDEBAR_CSS], ['conversation', CONVERSATION_CSS], ['secrets', SECRET_CSS], ['providers', PROVIDERS_CSS],
  ['models', MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + GROUP_SETTINGS_CSS], ['usage', USAGE_CSS], ['schedules', SCHEDULE_CSS],
  ['feedback', FEEDBACK_CSS], ['about', ABOUT_CSS], ['members', MEMBER_CSS],
]) installStyles(text, tag)

// The plugin's colors switch on body[data-ds-dark-theme], which DSH sets; here the system's
// light or dark mode sets it.
const dark = matchMedia('(prefers-color-scheme: dark)')
const paint = () => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
paint()
dark.addEventListener('change', paint)

createRoot(document.getElementById('root')).render(h(App))
