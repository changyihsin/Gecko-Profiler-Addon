/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Initial Developer of the Original Code is
 * Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Benoit Girard <bgirard@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {Cc,Ci,Cu} = require("chrome");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");

//var DEFAULT_UI_URL = "http://ehsan.github.com/cleopatra/";
var DEFAULT_UI_URL = "http://varium.fantasytalesonline.com/cleopatra/";
//var DEFAULT_UI_URL = "file:///Users/bgirard/ben/sps/cleopatra/index.html";
//var DEFAULT_UI_URL = "http://localhost/~markus/cleopatra/";
var DEFAULT_PROFILE_FORMAT = "string"; // or json
//var DEFAULT_PROFILE_FORMAT = "json";

let remote = require("remote");
let prefs = require("prefs");
let data = require("self").data;
let clipboard = require("clipboard");
let timers = require("timers");
let tabs = require("tabs");
let Request = require("request").Request;

let symbolicateModule = Cu.import(data.url("SymbolicateModule.jsm"));
let cmdRunnerModule = Cu.import(data.url("CmdRunner.jsm"));

var profiler = null;
var profilerFeatures = [];
var featuresToUse = [];
var startedWithFeatures = [];
var spsWidget = null;
var panel = null;
var c = 0;
var settingsTab = null;
var settingsTabPort = null;

String.prototype.endsWith = function(suffix) {
      return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

// add hotkey
const { XulKey } = require("xulkeys");
XulKey({
  id: "RR:DumpProfile",
  modifiers: "accel shift",
  key: "O",
  onCommand: function() {
    open_cleopatra();
  }
});
XulKey({
  id: "RR:ToggleProfiler",
  modifiers: "accel shift",
  key: "S",
  onCommand: function() {
    if (profiler.IsActive()) {
      profiler.StopProfiler();
    } else {
      sps_startup(true);
    }
    sps_update_status();
  }
});

function get_feature_pref() {
    var featurePrefs = {};
    for (var i = 0; i < profilerFeatures.length; i++) {
        var feature = profilerFeatures[i];
        featurePrefs[feature] = prefs.get_pref_bool("profiler.", feature);
    }
    return featurePrefs;
}

function sps_update_status() {
    var isActive = prefs.get_pref_bool("profiler.", "enabled");
    var isActive = profiler.IsActive();
    var profilerFeaturesPrefs = get_feature_pref();
    var runningLabel = "Start";
    var addonLabel = "Stopped";
    if (isActive) {
      runningLabel = "Stop";
      addonLabel = "Running";
    }
    spsWidget.content = "Profiler: " + addonLabel;
    var profilerStatus = {
        profilerFeatures: profilerFeatures, 
        profilerFeaturesPrefs: profilerFeaturesPrefs,
        startedWithFeatures: startedWithFeatures, 
        runningLabel: runningLabel, 
        isActive: isActive
    };
    panel.port.emit("change_status", profilerStatus);
    if (settingsTabPort)
      settingsTabPort.port.emit("change_status", profilerStatus);
}

function has_stackwalk() {
    var hh = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler);
    var platform = hh["platform"];
    if (platform === "X11") {
        platform = "Linux";
    }
    return platform === "Macintosh" || platform === "Windows" || platform === "Linux";
}
function has_feature(feature) {
    if (feature == "stackwalk" && !has_stackwalk())
        return false;
    return profilerFeatures.indexOf(feature) !== -1;
}
function get_profile_format() {
    return prefs.get_pref_string("profiler.", "format", DEFAULT_PROFILE_FORMAT).toLowerCase();
}
function is_string_profile_format() {
    return get_profile_format() === "string";
}
function is_json_profile_format() {
    return get_profile_format() === "json";
}

function sps_startup(force) {
    prefs.default_init_pref("profiler.", "stackwalk", true);
    prefs.default_init_pref("profiler.", "jank", false);
    prefs.default_init_pref("profiler.", "adb", true);
    prefs.default_init_pref_string("profiler.", "format", DEFAULT_PROFILE_FORMAT);
    prefs.default_init_pref_string("profiler.", "url", DEFAULT_UI_URL);

    if (prefs.get_pref_bool("profiler.", "enabled") || force == true) {
        var features = profilerFeatures;
        var entries = prefs.get_pref_int("profiler.", "entries");
        var interval = prefs.get_pref_int("profiler.", "interval");
        var want_feature_stackwalk = prefs.get_pref_bool("profiler.", "stackwalk", true);
        var want_feature_jank = prefs.get_pref_bool("profiler.", "jank", false);
        var want_feature_adb = prefs.get_pref_bool("profiler.", "adb", false);
        
        var selectedFeatures = [];
        if (has_feature("stackwalk") && want_feature_stackwalk) {
            selectedFeatures.push("stackwalk");
        }
        if (has_feature("jank") && want_feature_jank) {
            selectedFeatures.push("jank");
        }
        if (has_feature("adb") && want_feature_adb) {
            selectedFeatures.push("adb");
        }
        profiler.StartProfiler(entries, interval, selectedFeatures, selectedFeatures.length);
        startedWithFeatures = selectedFeatures;
        sps_update_status();
    }
}

function store_profile(callback) {
    get_profile(null, function(profile) {
        var storeRequest = Request({
          url: "http://profile-logs.appspot.com/store",
          content: {"file": profile},
          onComplete: function (response) {
            //for (var headerName in response.headers) {
            //    console.log(headerName + " : " + response.headers[headerName]);
            //}
            //console.log("Status text: " + response.text);
            
            // We can't get the redirect so for now we cheat
            // we need to modify the store to give the redirect url
            // in the response.
            var url = get_ui_url() + "?report=" + response.text;
            console.log("Upload profile to: " + url);
            callback(url);
          }
        }).post();
    });
}

function get_profile(progress_callback, finish_callback) {
    if (progress_callback != null) {
        progress_callback({progress: 0, action: "Retrieving profile"});
    }
    timers.setTimeout(function() {
        var profile;
        if (is_string_profile_format()) {
            profile = profiler.GetProfile();
        } else {
            profile = profiler.getProfileData();
        }
        if (profile == null) {
            progress_callback({progress: 1, action: "Empty profile"});
            return;
        }
        var sharedLibraries = profiler.getSharedLibraryInformation();
        symbolicateModule.symbolicate(profile, null, sharedLibraries,
                                      progress_callback,
                                      finish_callback);
    }, 0);
    return;
}

function adb_pull_libs(progress_callback, finish_callback) {
    cmdRunnerModule.runCommand("/bin/bash -l -c 'adb shell ls /system/lib'", function(r) {
        var lines = r.split("\n");
        var libsToPull = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.endsWith(".so") == false) continue;
            libsToPull.push(line);
        }
        var total = libsToPull.length;
        for (var i = 0; i < libsToPull.length; i++) {
            let libName = libsToPull[i];
            cmdRunnerModule.runCommand("/bin/bash -l -c 'adb pull /system/lib/" + libName + " /tmp'", function(r) {
                progress_callback({progress: (total-libsToPull.length)/total, action: "Pulled Android library: " + libName});
                libsToPull.splice(libsToPull.indexOf(libName), 1);
                dump("Pulled Android library: " + libName + "\n");
                if (libsToPull.length == 0) {
                    progress_callback({progress: 0, action: "Got all libraries"});
                }
            });
        }
    });
}

function adb_get_process_info(finish_callback) {
    cmdRunnerModule.runCommand("/bin/bash -l -c 'adb shell ps'", function(r) {
        var lines = r.split("\n");
        var fennecLine = null;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf("org.mozilla.fennec") != -1) {
                fennecLine = line;
                break;
            }
        }
        if (fennecLine == null) {
            finish_callback({error: "Fennec is not running."});
            return;
        }
        var fennecLineSplit = fennecLine.split(" ");
        var pid = null;
        var pkgName = null;
        for (var i = 1; i < fennecLineSplit.length; i++) {
            if (fennecLineSplit[i].trim() != "") {
                try {
                    pid = parseInt(fennecLineSplit[i].trim());
                    break;
                } catch (e) {
                    break;
                }
            }
        }
        pkgName = fennecLineSplit[fennecLineSplit.length-1].trim();
        if (pid == null || isNaN(pid)) {
            finish_callback({error: "Could not find PID in: " + fennecLine});
            return;
        }
        if (pkgName.indexOf("org.mozilla") != 0) {
            finish_callback({error: "Could not find package name: " + pkgName});
            return;
        }
        finish_callback( {pid: pid, pkgName: pkgName} );
    });
}

function adb_pull(progress_callback, finish_callback) {
    if (progress_callback != null) {
        progress_callback({progress: 0, action: "Check Env: ADB"});
    }
    cmdRunnerModule.runCommand("/bin/bash -l -c 'adb version'", function(r) {
        if (r.indexOf("Android Debug Bridge") != 0) {
            progress_callback({progress: 0, action: "Could not find 'adb', make sure it is in your PATH"});
            return;
        }
        progress_callback({progress: 0.05, action: "Check Env: Android device"});
        cmdRunnerModule.runCommand("/bin/bash -l -c 'adb shell pwd'", function(r) {
            if (r.indexOf("error: device not found") != -1 || r == "") {
                progress_callback({progress: 0, action: "Make sure that your phone is connected and has debugging enabled."});
                return;
            }
            progress_callback({progress: 0.1, action: "Check Env: Fennec process"});
            adb_get_process_info( function (processInfo) {
                if (processInfo.error != null) {
                    progress_callback({progress: 0, action: processInfo.error});
                    return
                }
                progress_callback({progress: 0.15, action: "Pulling profile: Send signal to pid: " + processInfo.pid});
                dump("Dump Profile: adb shell run-as " + processInfo.pkgName + " kill -12 " + processInfo.pid + "\n");
                cmdRunnerModule.runCommand("/bin/bash -l -c 'adb shell run-as " + processInfo.pkgName + " kill -12 " + processInfo.pid + "'", function(r) {
                    adb_get_process_info( function (processInfo2) {
                        if (processInfo2.error != null) {
                            // We killed fennec with the -12 signal since it wasn't started with profiling.
                            // Restart the process.
                            progress_callback({progress: 0.5, action: "Restarting Fennec with profiling enabled."});
                            cmdRunnerModule.runCommand("/bin/bash -l -c 'adb shell am start -n " + processInfo.pkgName + "/.App --es env0 MOZ_PROFILER_STARTUP=true'", function(r) {
                                progress_callback({progress: 0, action: "Restarted Fennec with profiling enabled."});

                            });
                            return;
                        }
                        progress_callback({progress: 0.2, action: "Waiting for save"});
                        var waitCount = 0;
                        var intervalId = timers.setInterval(function() {
                            waitCount += 50;
                            progress_callback({progress: (0.2 + waitCount/3000 * 0.4), action: "Waiting for save"});
                            if (waitCount < 3000) {
                                return;
                            }
                            timers.clearInterval(intervalId);
                            progress_callback({progress: 0, action: "Pulling profile: adb pull"});
                            cmdRunnerModule.runCommand("/bin/bash -l -c 'adb pull /sdcard/profile_0_" + processInfo.pid + ".txt /tmp/fennec_profile.txt'", function (r) {
                                progress_callback({progress: 0.6, action: "Pulling profile: reading"});
                                cmdRunnerModule.runCommand("/bin/bash -l -c 'adb shell rm /sdcard/profile_0_" + processInfo.pid + ".txt'", function (r) {});
                                cmdRunnerModule.runCommand("/bin/cat /tmp/fennec_profile.txt", function (r) {
                                    dump("Got raw profile: " + r.length + "\n");
                                    progress_callback({progress: 0.7, action: "Parsing"});
                                    symbolicateModule.symbolicate(r, "Android", null, progress_callback, finish_callback);
                                    //dump("Profile: '" + r + "'\n");
                                    //finish_callback(r);
                                });
                            });
                        }, 50);
                    });
                });
            });
        });
    });
}

/*
This feature should be moved to work within the cleopatra UI
function bugzilla_file_bug() {
    store_profile(bugzilla_file_bug_with_profile);
}

function bugzilla_file_bug_with_profile(url) {
    var onlyOnce = true;
    tabs.open({
        url: "https://bugzilla.mozilla.org/enter_bug.cgi?product=Core",
        onReady: function onReady(tab) {
            if (!onlyOnce) {
              return;
            }
            onlyOnce = false;
            var attach = tab.attach({
                contentScriptFile:
                    data.url("bugzilla.js")
            });
            attach.port.on("getaboutsupport", function(text) {
            
                var info = { 
                    "appname" : Services.appinfo.name,
                    "os" : Services.appinfo.OS,
                    "XPCOMABI" : Services.appinfo.XPCOMABI,
                    "toolkit" : Services.appinfo.toolkit,
                };
                
                var hh = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler);
                for each (var prop in [ "userAgent", "appName", "appVersion",
                             "vendor", "vendorSub",
                             "product", "productSub",
                             "platform", "oscpu", "language", "misc" ]) {
                    info[prop] = hh[prop];
                };
                var data = {
                    "url" : url,
                    "info" : info,
                };
                attach.port.emit("getaboutsupport", data);
            });
        }
    });
}
*/

function get_ui_url() {
    return prefs.get_pref_string("profiler.", "url", DEFAULT_UI_URL);
}

function open_settings() {
    if (settingsTab) {
      settingsTab.activate();
      return;
    }
    
    var onlyOnce = true;
    tabs.open({
        url: data.url("settings.html"),
        onReady: function onReady(tab) {
            if (!onlyOnce) {
              return;
            }
            settingsTab = tab;
            onlyOnce = false;
            var attach = tab.attach({
                contentScriptFile:
                    data.url("settings.js")
            });
            attach.port.on("set_feature", function(obj) {
                prefs.set_pref_bool("profiler.", obj.feature, obj.value);
                sps_update_status();
            });
            settingsTabPort = attach;
            sps_update_status();
        },
        onClose: function close() {
            settingsTabPort = null;
            settingsTab = null;
        },
    });
}

function open_cleopatra(profileType) {
    if (profileType == null) {
        profileType = "desktop";
    }
    var onlyOnce = true;
    var front_end_url = get_ui_url();
    tabs.open({
        url: front_end_url,
        onReady: function onReady(tab) {
            if (!onlyOnce) {
              return;
            }
            onlyOnce = false;
            var attach = tab.attach({
                contentScriptFile:
                    data.url("cleopatra.js")
            });
            attach.port.on("adblibs", function(text) {
                adb_pull_libs(function(msg) { // progress
                    attach.port.emit("getprofile_progress", msg);
                }, function(profile) { // complete
                });
            });
            attach.port.on("adbpull", function(text) {
                adb_pull(function(msg) { // progress
                    attach.port.emit("getprofile_progress", msg);
                }, function(profile) { // complete
                    attach.port.emit("getprofile", profile);
                });
            });
            attach.port.on("getprofile", function(text) {
                get_profile(function(msg) { // progress
                    attach.port.emit("getprofile_progress", msg);
                }, function(profile) { // complete
                    attach.port.emit("getprofile", profile);
                });
            });
            attach.port.emit("get_profile_" + profileType, "");
        }
    });
}

function init() {
    panel = require("panel").Panel({
        width:245,
        height:180,
        contentURL: data.url("sps_panel.html"),
        contentScriptFile: data.url("sps_panel.js"),
        contentScriptWhen: "ready",
        onShow: function() {
            panel.port.emit("onShow", null);
        },
        onHide: function() {
            panel.port.emit("onHide", null);  
        },
        onMessage: function() {
            return prefs.get_pref_bool("profiler.", "enabled");
        }
    });
    panel.port.on("toggle", function(text) {
        if (profiler.IsActive()) {
            profiler.StopProfiler();
        } else {
            sps_startup(true);
        }
        sps_update_status();
    });
    // Used by the checkbox to toggle a feature
    panel.port.on("set_feature", function(obj) {
        prefs.set_pref_bool("profiler.", obj.feature, obj.value);
    });
    panel.port.on("getprofile", function(text) {
        open_cleopatra("desktop");
        panel.hide();
    });
    panel.port.on("adblibs", function(text) {
        open_cleopatra("libs");
        panel.hide();
    });
    panel.port.on("adbpull", function(text) {
        open_cleopatra("adb");
        panel.hide();
    });
    panel.port.on("opensettings", function(text) {
        open_settings();
        panel.hide();
    });
    panel.port.on("filebug", function(text) {
        bugzilla_file_bug();
        panel.hide();
    });
    panel.port.on("responsive", function(text) {
        if (profiler) {
            var data = profiler.GetResponsivenessTimes({});
            panel.port.emit("responsive", data);
        }
    });
    try {
      profiler = Cc["@mozilla.org/tools/profiler;1"].getService(Ci.nsIProfiler);
    } catch(e) {
        spsWidget = require("widget").Widget({
          id: "hello-display",
          label: "Built-in Profiler",
          content: "Profiler module not found.",
          width: 200,
          panel: panel
        });
        return;
    }
    try {
        profilerFeatures = profiler.GetFeatures([]);
        // Add-on side feature
        profilerFeatures.push("adb");
    } catch(e) { }
    
    spsWidget = require("widget").Widget({
      id: "hello-display",
      label: "Built-in Profiler",
      content: "Profiler",
      width: 200,
      panel: panel
    });
    
    sps_startup(true);
    sps_update_status();
}

init();
