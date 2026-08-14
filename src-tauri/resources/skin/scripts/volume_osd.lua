-- volume_osd.lua：滚轮/音量控件调音量时，在左上角显示「音量：n%」两秒。
-- 也接收 modernz.lua 发来的通知文本（循环切换提示），在左上角同位置显示。
-- 替代 mpv 中央弹出的音量条（配合 no-osd 的滚轮命令一起用）。
-- 随 ZEX 皮肤部署到 <config>/scripts/，mpv 启动自动加载。
local ass = require "mp.assdraw"

local overlay = mp.create_osd_overlay("ass-events")
overlay.z = 2000 -- 盖在 ModernZ 控制栏（z=1000）之上
local hide_timer
-- 启动时先记下当前音量，避免 mpv 启动那一下也闪「音量：n%」
local last_v = math.floor(mp.get_property_number("volume", 0))

local function hide()
    if hide_timer then
        hide_timer:kill()
        hide_timer = nil
    end
    overlay.data = ""
    overlay:update()
end

-- 在左上角绘制一行提示（与顶部标题同字号），两秒后消失
local function draw_text(text)
    local w = mp.get_property_number("osd-width", 1920)
    local h = mp.get_property_number("osd-height", 1080)
    -- 画布 = 物理像素，字号按屏幕高度等比（1080p 时约 21px）
    overlay.res_x, overlay.res_y = w, h
    local fs = math.floor(h / 50) -- 与顶部标题字号（21）一致

    local a = ass.ass_new()
    a:pos(35, 52)      -- 距左上角（x=35 略右移；y=52 避开标题栏 42px）
    a:an(7)            -- 左上角对齐
    -- 白字黑边，中文走 libass 系统字体回退（与顶部栏标题同一机制）
    a:append(string.format("{\\fs%d\\bord2\\1c&HFFFFFF&\\3c&H000000&}%s", fs, text))
    overlay.data = a.text
    overlay:update()

    if hide_timer then hide_timer:kill() end
    hide_timer = mp.add_timeout(2.0, hide)
end

local function show(name, value)
    local v = math.floor(value or mp.get_property_number("volume", 0))
    if v == last_v then return end
    last_v = v
    draw_text("音量：" .. v .. "%")
end

-- 供 modernz.lua 通过 script-message-to 发送任意提示文本（如循环切换）
mp.register_script_message("notify", draw_text)

mp.observe_property("volume", "number", show)
mp.register_event("shutdown", hide)
