const St          = imports.gi.St;
const Gio         = imports.gi.Gio
const GLib        = imports.gi.GLib;
const Meta        = imports.gi.Meta;
const Shell       = imports.gi.Shell;
const Clutter     = imports.gi.Clutter;
const MessageTray = imports.ui.messageTray;
const Main        = imports.ui.main;
const CheckBox    = imports.ui.checkBox;
const PopupMenu   = imports.ui.popupMenu;
const Util        = imports.misc.util;
const Lang        = imports.lang;
const Signals     = imports.signals;
const Mainloop    = imports.mainloop;


const ME = imports.misc.extensionUtils.getCurrentExtension();


const Gettext  = imports.gettext.domain(ME.metadata['gettext-domain']);
const _        = Gettext.gettext;
const ngettext = Gettext.ngettext;


const FULLSCREEN    = ME.imports.lib.fullscreen;
const SIG_MANAGER   = ME.imports.lib.signal_manager;
const KEY_MANAGER   = ME.imports.lib.keybinding_manager;
const PANEL_ITEM    = ME.imports.lib.panel_item;
const NUM_PICKER    = ME.imports.lib.num_picker;


const IFACE = `${ME.path}/dbus/pomodoro_iface.xml`;


const CACHE_FILE = GLib.get_home_dir() +
                   '/.cache/timepp_gnome_shell_extension/timepp_pomodoro.json';


const START_MSG       = _('Work!');
const LONG_BREAK_MSG  = _('Long Break!')
const SHORT_BREAK_MSG = _('Short break!')


const PomoState = {
    STOPPED     : 'STOPPED',
    POMO        : 'POMO',
    LONG_BREAK  : 'LONG_BREAK',
    SHORT_BREAK : 'SHORT_BREAK',
};


const NotifStyle = {
    STANDARD   : 0,
    FULLSCREEN : 1,
};


// =====================================================================
// @@@ Main
//
// @ext      : obj (main extension object)
// @settings : obj (extension settings)
// =====================================================================
var Pomodoro = new Lang.Class({
    Name: 'Timepp.Pomodoro',

    _init: function (ext, settings) {
        this.ext      = ext;
        this.settings = settings;


        {
            let [,xml,] = Gio.file_new_for_path(IFACE).load_contents(null);
            xml = '' + xml;
            this.dbus_impl = Gio.DBusExportedObject.wrapJSObject(xml, this);
        }


        this.section_enabled  = this.settings.get_boolean('pomodoro-enabled');
        this.separate_menu    = this.settings.get_boolean('pomodoro-separate-menu');
        this.pomo_state       = PomoState.STOPPED;
        this.clock            = 0; // seconds
        this.end_time         = 0; // for computing elapsed time (microseconds)
        this.tic_mainloop_id  = null;
        this.cache_file       = null;
        this.cache            = null;


        this.fullscreen = new PomodoroFullscreen(this.ext, this,
            this.settings.get_int('pomodoro-fullscreen-monitor-pos'));


        this.sigm = new SIG_MANAGER.SignalManager();
        this.keym = new KEY_MANAGER.KeybindingManager(this.settings);


        //
        // register shortcuts (need to be enabled later on)
        //
        this.keym.register('pomodoro-keybinding-open', () => {
             this.ext.open_menu(this);
        });
        this.keym.register('pomodoro-keybinding-open-fullscreen', () => {
            this.show_fullscreen();
        });


        //
        // panel item
        //
        this.panel_item = new PANEL_ITEM.PanelItem(ext.menu);
        this.panel_item.icon.icon_name = 'timepp-pomodoro-symbolic';

        this.panel_item.set_label(this.settings.get_boolean('pomodoro-show-seconds') ? '00:00:00' : '00:00');
        this.panel_item.actor.add_style_class_name('pomodoro-panel-item');

        this._toggle_panel_mode();

        ext.panel_item_box.add_actor(this.panel_item.actor);


        //
        // pomodoro pane
        //
        this.actor = new St.BoxLayout({ vertical: true, style_class: 'section pomo-section' });


        //
        // header
        //
        this.header = new PopupMenu.PopupMenuItem(_('Pomodoro'), { hover: false, activate: false, style_class: 'header' });
        this.header.actor.can_focus = false;
        this.header.label.x_expand = true;
        this.header.label.add_style_class_name('clock');
        this.actor.add_actor(this.header.actor);


        // pomo phase label
        this.phase_label = new St.Label({ y_align: Clutter.ActorAlign.CENTER, style_class: 'pomo-phase-label popup-inactive-menu-item', pseudo_class: 'insensitive' });
        this.header.actor.add_child(this.phase_label);


        // clock
        this.clock_label = new St.Label({ y_align: Clutter.ActorAlign.CENTER, style_class: 'pomo-counter' });
        this.header.actor.add_child(this.clock_label);


        // icons
        this.icon_box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.END, style_class: 'icon-box' });
        this.header.actor.add_actor(this.icon_box);

        this.fullscreen_btn = new St.Button({ can_focus: true, y_align: St.Align.MIDDLE, x_align: St.Align.END, style_class: 'fullscreen-icon' });
        this.icon_box.add_actor(this.fullscreen_btn);
        this.fullscreen_icon = new St.Icon({ icon_name: 'timepp-fullscreen-symbolic' });
        this.fullscreen_btn.add_actor(this.fullscreen_icon);

        this.settings_btn = new St.Button({ can_focus: true, x_align: St.Align.END, y_align: St.Align.MIDDLE, style_class: 'settings-icon' });
        this.icon_box.add_actor(this.settings_btn);
        this.settings_icon = new St.Icon({ icon_name: 'timepp-settings-symbolic' });
        this.settings_btn.add_actor(this.settings_icon);


        //
        // buttons
        //
        this.btn_box_wrapper = new PopupMenu.PopupMenuItem('', { hover: false, activate: false });
        this.actor.add_actor(this.btn_box_wrapper.actor);
        this.btn_box_wrapper.label.hide();
        this.btn_box_wrapper.actor.can_focus = false;

        this.button_box = new St.BoxLayout({ style_class: 'btn-box' });
        this.btn_box_wrapper.actor.add(this.button_box, {expand: true});

        this.button_new_pomo = new St.Button({can_focus:  true, label: _('New Pomo'), x_expand: true, visible: false, style_class: 'button'});
        this.button_take_break = new St.Button({can_focus: true, label: _('Take Break'), x_expand: true, visible: false, style_class: 'button'});
        this.button_start = new St.Button({can_focus: true, label: _('Start'), x_expand: true, style_class: 'button'});
        this.button_stop = new St.Button({can_focus: true, label: _('Stop'), x_expand: true, visible: false, style_class: 'button'});

        this.button_box.add(this.button_new_pomo, {expand: true});
        this.button_box.add(this.button_take_break, {expand: true});
        this.button_box.add(this.button_start, {expand: true});
        this.button_box.add(this.button_stop, {expand: true});


        //
        // settings container
        //
        this.settings_container = new St.Bin({x_fill: true});
        this.actor.add_actor(this.settings_container);


        //
        // listen
        //
        this.sigm.connect(this.fullscreen, 'monitor-changed', () => {
            this.settings.set_int('pomodoro-fullscreen-monitor-pos', this.fullscreen.monitor);
        });
        this.sigm.connect(this.settings, 'changed::pomodoro-separate-menu', () => {
            this.separate_menu = this.settings.get_boolean('pomodoro-separate-menu');
            this.ext.update_panel_items();
        });
        this.sigm.connect(this.settings, 'changed::pomodoro-show-seconds', () => {
            this._update_time_display();
        });
        this.sigm.connect(this.settings, 'changed::pomodoro-panel-mode', () => {
            this._toggle_panel_mode();
        });
        this.sigm.connect(this.panel_item.actor, 'key-focus-in', () => {
            // user has right-clicked to show the context menu
            if (this.ext.menu.isOpen && this.ext.context_menu.actor.visible)
                return;

            this.ext.open_menu(this);
        });
        this.sigm.connect(this.panel_item, 'left-click', () => this.ext.toggle_menu(this));
        this.sigm.connect(this.panel_item, 'right-click', () => this.ext.toggle_context_menu(this));
        this.sigm.connect(this.panel_item, 'middle-click', () => this.timer_toggle());
        this.sigm.connect_press(this.settings_btn, () => this._show_settings());
        this.sigm.connect_press(this.fullscreen_btn, () => this.show_fullscreen());
        this.sigm.connect_press(this.button_start, () => this.start_pomo());
        this.sigm.connect_press(this.button_stop, () => this.stop());
        this.sigm.connect_press(this.button_new_pomo, () => this.start_new_pomo());
        this.sigm.connect_press(this.button_take_break, () => this.take_break());


        if (this.section_enabled) this.enable_section();
        else                      this.sigm.disconnect_all();
    },

    on_section_open_state_changed: function (state) {
        if (state) {
            this.panel_item.actor.add_style_pseudo_class('checked');
            this.panel_item.actor.can_focus = false;
        }
        else {
            this.panel_item.actor.remove_style_pseudo_class('checked');
            this.panel_item.actor.can_focus = true;
        }

        this.emit('section-open-state-changed', state);
    },

    toggle_section: function () {
        if (this.section_enabled) {
            this.disable_section();
        }
        else {
            this.sigm.connect_all();
            this.enable_section();
        }

        this.section_enabled = this.settings.get_boolean('pomodoro-enabled');
        this.ext.update_panel_items();
    },

    disable_section: function () {
        this.dbus_impl.unexport();
        this.stop();
        this._store_cache();
        this.sigm.clear();
        this.keym.disable_all();

        if (this.fullscreen) {
            this.fullscreen.destroy();
            this.fullscreen = null;
        }
    },

    enable_section: function () {
        // init cache file
        try {
            this.cache_file = Gio.file_new_for_path(CACHE_FILE);

            let cache_format_version =
                ME.metadata['cache-file-format-version'].pomodoro;

            if (this.cache_file.query_exists(null)) {
                let [, contents] = this.cache_file.load_contents(null);
                this.cache = JSON.parse(contents);
            }

            if (!this.cache || !this.cache.format_version ||
                this.cache.format_version !== cache_format_version) {

                this.cache = {
                    format_version  : cache_format_version,
                    pomo_counter    : 0,
                    pomo_duration   : 150, // seconds
                    short_break     : 300, // seconds
                    long_break      : 900, // seconds
                    long_break_rate : 4,
                };
            }
        }
        catch (e) {
            logError(e);
            return;
        }

        let count_str         = String(this.cache.pomo_counter);
        this.clock_label.text = this.cache.pomo_counter ? count_str : '';
        this.clock            = this.cache.pomo_duration;

        if (! this.fullscreen) {
            this.fullscreen = new PomodoroFullscreen(this.ext, this,
                this.settings.get_int('pomodoro-fullscreen-monitor-pos'));
        }

        this.dbus_impl.export(Gio.DBus.session, '/timepp/zagortenay333/Pomodoro');
        this.keym.enable_all();
        this._update_time_display();
        this.header.label.text = _('Pomodoro');
    },

    _store_cache: function () {
        if (! this.cache_file.query_exists(null))
            this.cache_file.create(Gio.FileCreateFlags.NONE, null);

        this.cache_file.replace_contents(JSON.stringify(this.cache, null, 2),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    },

    _show_settings: function () {
        let settings = new PomodoroSettings(this, this.cache);
        this.settings_container.add_actor(settings.actor);
        settings.button_cancel.grab_key_focus();

        this.header.actor.hide();
        this.btn_box_wrapper.actor.hide();

        settings.connect('ok', (_, res) => {
            this.set_phase_durations(
                res.pomo, res.short_break, res.long_break, res.break_rate);

            if (this.pomo_state === PomoState.STOPPED)
                this.clock = this.cache.pomo_duration;

            if (res.clear_counter)
                this.clear_pomo_counter();

            this.btn_box_wrapper.actor.show();
            this.button_box.grab_key_focus();
            settings.actor.destroy();
            this.header.actor.show();

            this._update_time_display();
        });

        settings.connect('cancel', () => {
            this.btn_box_wrapper.actor.show();
            this.actor.grab_key_focus();
            settings.actor.destroy();
            this.header.actor.show();
        });
    },

    show_fullscreen: function () {
        this.ext.menu.close();

        if (! this.fullscreen) {
            this.fullscreen = new PomodoroFullscreen(this.ext, this,
                this.settings.get_int('pomodoro-fullscreen-monitor-pos'));
        }

        this.fullscreen.open();
    },

    clear_pomo_counter: function () {
        this.cache.pomo_counter = 0;
        this.clock_label.text = '';

        this._store_cache();
    },

    // @pomo        : int (seconds)
    // @short_break : int (seconds)
    // @long_break  : int (seconds)
    // @break_rate  : int (num of pomos until long break)
    set_phase_durations: function (pomo, short_break, long_break, break_rate) {
        this.cache.pomo_duration   = Math.max(1, pomo);
        this.cache.short_break     = Math.max(1, short_break);
        this.cache.long_break      = Math.max(1, long_break);
        this.cache.long_break_rate = Math.max(1, break_rate);

        this._store_cache();
    },

    _maybe_stop_tracking: function () {
        if (! this.settings.get_boolean('pomodoro-stop-tracking'))
            return;

        this.emit('stop-time-tracking');
    },

    stop: function () {
        if (this.tic_mainloop_id) {
            Mainloop.source_remove(this.tic_mainloop_id);
            this.tic_mainloop_id = null;
        }

        if (this.pomo_state === PomoState.STOPPED)
            return;

        if (this.pomo_state !== PomoState.POMO) {
            this.clock             = this.cache.pomo_duration;
            this.header.label.text = _('Pomodoro');
        }

        this.pomo_state = PomoState.STOPPED;

        if (!this.fullscreen.is_open && this.actor.visible)
            this.button_stop.grab_key_focus();

        this.fullscreen.on_stop();
        this._update_phase_label();
        this._update_buttons();
        this._update_panel_item();

        if (this.settings.get_boolean('pomodoro-stop-tracking'))
            this.emit('stop-time-tracking');

        this.dbus_impl.emit_signal(
            'pomo_state_changed', GLib.Variant.new('(s)', [this.pomo_state]));

        this._maybe_stop_tracking();
    },

    start_new_pomo: function () {
        this.start_pomo(this.cache.pomo_duration);
    },

    // @time: int (seconds)
    start_pomo: function (time = this.clock) {
        if (this.tic_mainloop_id) {
            Mainloop.source_remove(this.tic_mainloop_id);
            this.tic_mainloop_id = null;
        }

        this.pomo_state = PomoState.POMO;
        this.end_time   = GLib.get_monotonic_time() + (time * 1000000);
        this.clock      = time;

        this.dbus_impl.emit_signal(
            'pomo_state_changed', GLib.Variant.new('(s)', [this.pomo_state]));

        this.fullscreen.on_start();
        this._update_time_display();
        this._update_panel_item();
        this._update_buttons();
        this._update_phase_label();

        if (!this.fullscreen.is_open && this.actor.visible)
            this.button_stop.grab_key_focus();

        this._tic();
    },

    take_break: function () {
        if (this.tic_mainloop_id) {
            Mainloop.source_remove(this.tic_mainloop_id);
            this.tic_mainloop_id = null;
        }

        if (this.cache.pomo_counter &&
            ((this.cache.pomo_counter % this.cache.long_break_rate) === 0)) {

            this.pomo_state = PomoState.LONG_BREAK;
            this.clock      = this.cache.long_break;
        }
        else {
            this.pomo_state = PomoState.SHORT_BREAK;
            this.clock      = this.cache.short_break;
        }

        this.end_time = GLib.get_monotonic_time() + (this.clock * 1000000);

        this.fullscreen.on_break();
        this._update_time_display();
        this._update_phase_label();
        this._update_buttons();
        this._update_panel_item();
        this._maybe_stop_tracking();

        if (this.settings.get_boolean('pomodoro-stop-tracking'))
            this.emit('stop-time-tracking');

        this.dbus_impl.emit_signal(
            'pomo_state_changed', GLib.Variant.new('(s)', [this.pomo_state]));

        this._tic();
    },

    timer_toggle: function () {
        if (this.pomo_state === PomoState.STOPPED)
            this.start_pomo();
        else
            this.stop();
    },

    _update_time_display: function () {
        let time = this.clock;

        // If the seconds are not shown, we need to make the timer '1-indexed'
        // with respect to minutes. I.e., 00:00:34 becomes 00:01.
        if (this.settings.get_boolean('pomodoro-show-seconds')) {
            this.header.label.text = "%02d:%02d:%02d".format(
                Math.floor(time / 3600),
                Math.floor(time % 3600 / 60),
                time % 60
            );
        }
        else {
            if (this.clock > 0 && this.clock !== this.cache.pomo_duration) {
                time += 60;
            }

            this.header.label.text = "%02d:%02d".format(
                Math.floor(time / 3600),
                Math.floor(time % 3600 / 60)
            );
        }

        if (this.panel_item.label.visible)
            this.panel_item.set_label(this.header.label.text);

        this.fullscreen.set_banner_text(this.header.label.text);
    },

    _update_phase_label: function () {
        switch (this.pomo_state) {
            case PomoState.POMO:
                this.phase_label.text            = START_MSG;
                this.fullscreen.phase_label.text = START_MSG;
                break;
            case PomoState.LONG_BREAK:
                this.phase_label.text            = LONG_BREAK_MSG;
                this.fullscreen.phase_label.text = LONG_BREAK_MSG;
                break;
            case PomoState.SHORT_BREAK:
                this.phase_label.text            = SHORT_BREAK_MSG;
                this.fullscreen.phase_label.text = SHORT_BREAK_MSG;
                break;
            case PomoState.STOPPED:
                this.phase_label.text            = '';
                this.fullscreen.phase_label.text = '';
                break;
        }
    },

    _update_panel_item: function () {
        if (this.pomo_state === PomoState.STOPPED)
            this.panel_item.actor.remove_style_class_name('on');
        else
            this.panel_item.actor.add_style_class_name('on');
    },

    _update_buttons: function () {
        switch (this.pomo_state) {
            case PomoState.POMO:
                this.button_start.visible                 = false;
                this.button_stop.visible                  = true;
                this.button_take_break.visible            = true;
                this.button_new_pomo.visible              = true;

                this.fullscreen.button_start.visible      = false;
                this.fullscreen.button_stop.visible       = true;
                this.fullscreen.button_take_break.visible = true;
                this.fullscreen.button_new_pomo.visible   = true;
                break;

            case PomoState.SHORT_BREAK:
            case PomoState.LONG_BREAK:
                this.button_start.visible                 = false;
                this.button_stop.visible                  = true;
                this.button_take_break.visible            = false;
                this.button_new_pomo.visible              = true;

                this.fullscreen.button_start.visible      = false;
                this.fullscreen.button_stop.visible       = true;
                this.fullscreen.button_take_break.visible = false;
                this.fullscreen.button_new_pomo.visible   = true;
                break;

            case PomoState.STOPPED:
                this.button_start.visible                 = true;
                this.button_stop.visible                  = false;
                this.button_take_break.visible            = false;
                this.button_new_pomo.visible              = false;

                this.fullscreen.button_start.visible      = true;
                this.fullscreen.button_stop.visible       = false;
                this.fullscreen.button_take_break.visible = false;
                this.fullscreen.button_new_pomo.visible   = false;
                break;
        }
    },

    _timer_expired: function () {
        if (this.pomo_state === PomoState.LONG_BREAK ||
            this.pomo_state === PomoState.SHORT_BREAK) {

            this.start_new_pomo();
        }
        else {
            this.cache.pomo_counter += 1;
            this._store_cache();
            this.take_break();
            this.clock_label.text = '' + this.cache.pomo_counter;
        }

        this._send_notif();
    },

    _tic: function () {
        if (this.clock < 1) {
            this.tic_mainloop_id = null;
            this._timer_expired();
            return;
        }

        this._update_time_display();

        this.clock =
            Math.floor((this.end_time - GLib.get_monotonic_time()) / 1000000);

        this.tic_mainloop_id = Mainloop.timeout_add_seconds(1, () => {
            this._tic();
        });
    },

    _send_notif: function () {
        let msg;

        switch (this.pomo_state) {
            case PomoState.POMO:        msg = START_MSG;       break;
            case PomoState.SHORT_BREAK: msg = SHORT_BREAK_MSG; break;
            case PomoState.LONG_BREAK:  msg = LONG_BREAK_MSG;  break;
            default: return;
        }

        if (this.settings.get_boolean('pomodoro-play-sound')) {
            let sound_file = this.settings.get_string('pomodoro-sound-file-path');

            if (sound_file) {
                [sound_file,] = GLib.filename_from_uri(sound_file, null);
                global.play_sound_file(0, sound_file, '', null);
            }
        }

        if (this.settings.get_enum('pomodoro-notif-style') === NotifStyle.FULLSCREEN) {
            this.fullscreen.open();
            return;
        }

        if (this.fullscreen.is_open)
            return;

        let source = new MessageTray.Source();
        Main.messageTray.add(source);

        let icon = new St.Icon({ icon_name: 'timepp-pomodoro-symbolic' });

        let params = {
            bannerMarkup : true,
            gicon        : icon.gicon,
        };

        let notif = new MessageTray.Notification(source, msg, '', params);

        notif.setUrgency(MessageTray.Urgency.HIGH);
        notif.setTransient(true);

        source.notify(notif);
    },

    _toggle_panel_mode: function () {
        if (this.settings.get_enum('pomodoro-panel-mode') === 0)
            this.panel_item.set_mode('icon');
        else if (this.settings.get_enum('pomodoro-panel-mode') === 1)
            this.panel_item.set_mode('text');
        else
            this.panel_item.set_mode('icon_text');
    },
});
Signals.addSignalMethods(Pomodoro.prototype);



// =====================================================================
// @@@ Pomodoro settings
//
// @delegate   : obj (main section object)
// @pomo_cache : obj (section cache object)
//
// @signals: 'ok', 'cancel'
// =====================================================================
const PomodoroSettings = new Lang.Class({
    Name: 'Timepp.PomodoroSettings',

    _init: function(delegate, pomo_cache) {
        this.delegate = delegate;

        this.actor = new St.BoxLayout({style_class: 'view-box'});

        this.content_box = new St.BoxLayout({vertical: true, style_class: 'view-box-content'});
        this.actor.add(this.content_box, {expand: true});


        //
        // clear all pomodoros
        //
        this.clear_all_item = new St.BoxLayout({style_class: 'row'});
        this.content_box.add_actor(this.clear_all_item);

        this.clear_item_label = new St.Label({text: _('Clear all pomodoros?'), y_align: Clutter.ActorAlign.CENTER});
        this.clear_all_item.add(this.clear_item_label, {expand: true});

        this.clear_checkbox_bin = new St.Bin();
        this.clear_all_item.add_actor(this.clear_checkbox_bin);

        this.clear_item_checkbox = new CheckBox.CheckBox();
        this.clear_checkbox_bin.add_actor(this.clear_item_checkbox.actor);


        //
        // pomodoro duration
        //
        this.pomo_duration = new St.BoxLayout({style_class: 'row'});
        this.content_box.add_actor(this.pomo_duration);

        this.pomo_label = new St.Label({text: _('Pomodoro (min:sec):'), y_align: Clutter.ActorAlign.CENTER});
        this.pomo_duration.add(this.pomo_label, {expand: true});

        this.pomo_dur_min_picker = new NUM_PICKER.NumPicker(0, null);
        this.pomo_duration.add_actor(this.pomo_dur_min_picker.actor);
        this.pomo_dur_min_picker.set_counter(
            Math.floor(pomo_cache.pomo_duration / 60));

        this.pomo_dur_sec_picker = new NUM_PICKER.NumPicker(1, null);
        this.pomo_duration.add_actor(this.pomo_dur_sec_picker.actor);
        this.pomo_dur_sec_picker.set_counter(pomo_cache.pomo_duration % 60);


        //
        // short break
        //
        this.short_break = new St.BoxLayout({style_class: 'row'});
        this.content_box.add_actor(this.short_break);

        this.short_break_label = new St.Label({text: _('Short break (min:sec):'), y_align: Clutter.ActorAlign.CENTER});
        this.short_break.add(this.short_break_label, {expand: true});

        this.short_break_min_picker = new NUM_PICKER.NumPicker(0, null);
        this.short_break.add_actor(this.short_break_min_picker.actor);
        this.short_break_min_picker.set_counter(
            Math.floor(pomo_cache.short_break / 60));

        this.short_break_sec_picker = new NUM_PICKER.NumPicker(1, null);
        this.short_break.add_actor(this.short_break_sec_picker.actor);
        this.short_break_sec_picker.set_counter(pomo_cache.short_break % 60);



        //
        // long break
        //
        this.long_break = new St.BoxLayout({style_class: 'row'});
        this.content_box.add_actor(this.long_break);

        this.long_break_label = new St.Label({text: _('Long break (min:sec):'), y_align: Clutter.ActorAlign.CENTER});
        this.long_break.add(this.long_break_label, {expand: true});

        this.long_break_min_picker = new NUM_PICKER.NumPicker(0, null);
        this.long_break.add_actor(this.long_break_min_picker.actor);
        this.long_break_min_picker.set_counter(
            Math.floor(pomo_cache.long_break / 60));

        this.long_break_sec_picker = new NUM_PICKER.NumPicker(1, null);
        this.long_break.add_actor(this.long_break_sec_picker.actor);
        this.long_break_sec_picker.set_counter(pomo_cache.long_break % 60);


        //
        // how many pomodoros 'till long break
        //
        this.long_break_rate = new St.BoxLayout({style_class: 'row'});
        this.content_box.add_actor(this.long_break_rate);

        this.long_break_rate_label = new St.Label({text: _('Num of pomos until long break:'), y_align: Clutter.ActorAlign.CENTER});
        this.long_break_rate.add(this.long_break_rate_label, {expand: true});

        this.long_break_rate_picker = new NUM_PICKER.NumPicker(1, null);
        this.long_break_rate.add_actor(this.long_break_rate_picker.actor);

        this.long_break_rate_picker.set_counter(pomo_cache.long_break_rate);


        //
        // buttons
        //
        this.button_box = new St.BoxLayout({ style_class: 'row btn-box' });
        this.content_box.add(this.button_box, {expand: true});

        this.button_ok      = new St.Button({can_focus: true, label: _('Ok'), x_expand: true, style_class: 'button'});
        this.button_cancel = new St.Button({can_focus: true, label: _('Cancel'), x_expand: true, style_class: 'button'});

        this.button_box.add(this.button_cancel, {expand: true});
        this.button_box.add(this.button_ok, {expand: true});


        //
        // listen
        //
        this.button_ok.connect('clicked', () => {
            this.emit('ok', {
                clear_counter : this.clear_item_checkbox.actor.checked,
                break_rate    : this.long_break_rate_picker.counter,
                pomo          : this.pomo_dur_min_picker.counter * 60 +
                                this.pomo_dur_sec_picker.counter,
                short_break   : this.short_break_min_picker.counter * 60 +
                                this.short_break_sec_picker.counter,
                long_break    : this.long_break_min_picker.counter * 60 +
                                this.long_break_sec_picker.counter,
            });
        });
        this.button_cancel.connect('clicked', () => {
            this.emit('cancel');
        });
    },
});
Signals.addSignalMethods(PomodoroSettings.prototype);



// =====================================================================
// @@@ Pomodoro fullscreen
//
// @ext      : obj (main extension object)
// @delegate : obj (main section object)
// @monitor  : int
//
// signals: 'monitor-changed'
// =====================================================================
const PomodoroFullscreen = new Lang.Class({
    Name    : 'Timepp.PomodoroFullscreen',
    Extends : FULLSCREEN.Fullscreen,

    _init: function (ext, delegate, monitor) {
        this.parent(monitor);

        this.ext      = ext;
        this.delegate = delegate;

        this.default_style_class = this.actor.style_class;


        //
        // phase label
        //
        this.phase_label = new St.Label({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style_class: 'pomo-phase-label' });
        this.middle_box.insert_child_at_index(this.phase_label, 0);


        //
        // buttons
        //
        this.button_box = new St.BoxLayout({ x_expand: true, y_expand: true, style_class: 'btn-box', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, });
        this.bottom_box.add_child(this.button_box)

        this.button_new_pomo   = new St.Button({can_focus: true, label: _('New Pomo'), visible: false, style_class: 'button'});
        this.button_take_break = new St.Button({can_focus: true, label: _('Take Break'), visible: false, style_class: 'button'});
        this.button_start      = new St.Button({can_focus: true, label: _('Start'), style_class: 'button'});
        this.button_stop       = new St.Button({can_focus: true, label: _('Stop'), visible: false, style_class: 'button'});
        this.button_box.add_child(this.button_new_pomo);
        this.button_box.add_child(this.button_take_break);
        this.button_box.add_child(this.button_start);
        this.button_box.add_child(this.button_stop);


        //
        // listen
        //
        this.button_start.connect('clicked', () => {
            this.delegate.start();
            return Clutter.EVENT_STOP;
        });
        this.button_stop.connect('clicked', () => {
            this.delegate.stop();
            return Clutter.EVENT_STOP;
        });
        this.button_new_pomo.connect('clicked',() => {
            this.delegate.start_new_pomo();
            return Clutter.EVENT_STOP;
        });
        this.button_take_break.connect('clicked', () => {
            this.delegate.take_break();
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('key-release-event', (_, event) => {
            switch (event.get_key_symbol()) {
                case Clutter.KEY_space:
                    this.delegate.timer_toggle();
                    return Clutter.EVENT_STOP;
                default:
                    return Clutter.EVENT_PROPAGATE;
            }
        });
    },

    on_start: function () {
        switch (this.delegate.pomo_state) {
            case PomoState.POMO:
                this.actor.style_class = this.default_style_class + ' pomo-running';
                break;
            case PomoState.LONG_BREAK:
                this.actor.style_class = this.default_style_class + ' pomo-long-break';
                break;
            case PomoState.SHORT_BREAK:
                this.actor.style_class = this.default_style_class + ' pomo-short-break';
                break;
        }
    },

    on_stop: function () {
        this.actor.style_class = this.default_style_class + ' pomo-stopped';
        this.phase_label.text  = '';
    },

    on_new_pomo: function () {
        this.actor.style_class = this.default_style_class + ' pomo-running';
        this.phase_label.text  = START_MSG;
    },

    on_break: function () {
        switch (this.delegate.pomo_state) {
            case PomoState.LONG_BREAK:
                this.actor.style_class = this.default_style_class + ' pomo-long-break';
                this.phase_label.text  = LONG_BREAK_MSG;
                break;
            case PomoState.SHORT_BREAK:
                this.actor.style_class = this.default_style_class + ' pomo-short-break';
                this.phase_label.text  = SHORT_BREAK_MSG;
                break;
        }
    },
});
Signals.addSignalMethods(PomodoroFullscreen.prototype);
