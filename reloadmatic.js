// Configuration format version
const CONFIG_VERSION = 1

// Conversion factor from seconds to minutes
const TIME_FACTOR = 1.0 / 60.0

// true if we can use session APIs from FF 57.0
const session57Available = (typeof browser.sessions.setTabValue === "function")

// Here we store all our data about tabs
var state = new Map()

// Here we store all pages for the "Remember" feature
var urlMemory = new Map();

// ID of the currently focused window
var CurrentWindowId = 0

// Here we store all user settings for the plugin
var Settings;

function objKey(tabId) {
    return `tab-${tabId}-alarm`;
}

// Returns a default-initialized instance of the object
// that describes all add-on related properties of a
// browser tab.
function newTabProps(tabId) {
    let ret = {
        // User Settings
        // ******************************
        randomize: false,           // whether "Randomize" is enabled
        loadError: false,           // whether there was an error in loading the page
        smart: false,                // whether "Smart timing" is enabled
        onlyOnError: false,         // whether "Only if unsuccessful" is enabled
        stickyReload: false,        // whether to keep reloading after page changes
        nocache: false,             // whether "Disable cache" is enabled
        remember: false,            // whether settings for this URL will be remembered
        period: -1,                 // canonical autoreload interval

        // Internal State
        // ******************************
        alarmName: objKey(tabId),   // name of the alarm and key in collections
        keepRefreshing: false,      // true if periodic refresh should not be disabled
        freezeUntil: 0,             // time until we are not allowed to reload
        tabId: tabId,               // id of the tab we belong to
        reqMethod: "GET",           // HTTP method the page was retrieved with
        postConfirmed: false,       // true if user wants to resend POST data
        scrollX: undefined,         // Horizontal scroll position of page
        scrollY: undefined,         // Vertical scroll position of page
        url: "",                    // Current or currently loading URL of tab,
        reloadByAddon: false        // true if the current reload was initiated by us
    };

    // Apply default user options
    Object.keys(Settings.defaults).forEach(function (key, index) {
        ret[key] = Settings.defaults[key];
    });

    return ret;
}

function getTabProps(tabId) {
    let alarm_name = objKey(tabId)
    if (state.has(alarm_name)) {
        return state.get(alarm_name)
    } else {
        let obj = newTabProps(tabId)
        state.set(alarm_name, obj)
        return obj
    }
}

// Free up resources we don't need anymore
browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    let key = objKey(tabId)
    browser.alarms.clear(key)
    state.delete(key)
})

function restartAlarm(obj) {
    // If period is negative we are deleting the alarm
    browser.alarms.clear(obj.alarmName)
    if (obj.period < 0) {
        obj.postConfirmed = false;
        browser.tabs.sendMessage(obj.tabId, {event: "timer-disabled"});
        return
    }

    // Create new alarm
    let period = obj.period
    if (obj.randomize) {
        let min = period * 0.5
        let max = period * 1.5
        period = Math.random() * (max - min + 1) + min
    }
    browser.alarms.create(obj.alarmName, { delayInMinutes: period * TIME_FACTOR });
    browser.tabs.sendMessage(obj.tabId, {event: "timer-enabled"});
}

function applyTabProps(obj) {
    return refreshMenu()
        .then(() => restartAlarm(obj))
        .then(() => {
            if (session57Available) {
                return browser.sessions.setTabValue(obj.tabId, "reloadmatic", obj);
            }
        });
}

function setTabPeriod(obj, period) {
    browser.tabs.get(obj.tabId).then((tab) => {   // prevents saving if tab does not exist anymore

        // If this page was requested using POST, make sure the user
        // knows the risks and really wants to refresh
        if ((obj.reqMethod != "GET") && (period != -1) && !obj.postConfirmed && !Settings.neverConfirmPost) {
            let popupURL = browser.extension.getURL("pages/post-confirm.html");
            let createData = {
                type: "popup",
                url: `${popupURL}?tabId=${obj.tabId}&period=${period}`,
                width: 800,
                height: 247
            };
            browser.windows.create(createData).then((win) => {
                browser.windows.update(win.id, { drawAttention: true })
            });
            return;
        }

        // Custom interval
        if (period == -2) {
            let popupURL = browser.extension.getURL("pages/custom-interval.html");
            let createData = {
                type: "popup",
                url: `${popupURL}?tabId=${obj.tabId}`,
                width: 400,
                height: 247
            };
            browser.windows.create(createData).then((win) => {
                browser.windows.update(win.id, { drawAttention: true })
            });
            return;
        }

        // Set period truely
        obj.period = period;
        applyTabProps(obj);
        rememberSet(obj);
    });
}

function rememberSet(obj) {
    // We need the tab's URL
    return browser.tabs.get(obj.tabId).then((tab) => {

        // Don't store anything on the computer in incognito mode
        if (tab.incognito) {
            return;
        }

        // We use only portions of the URL to generalize it to a certain page
        // without protocol or query parameters
        let url = parseUri(tab.url);
        url = url.authority + url.path;

        // Store (or delete)
        if (obj.remember) {
            urlMemory.set(url, clone(obj));
        } else {
            urlMemory.delete(url);
        }

        return browser.storage.local.set({
            // We can only serialize Map objects "unpacked"
            urlMemory: [...urlMemory]
        });
    });
}

function migratePropObj(newObj, oldObj) {
    let tmp = clone(oldObj);
    tmp.tabId = newObj.tabId;
    tmp.alarmName = newObj.alarmName;
    Object.keys(newObj).forEach(function (key, index) {
        if (tmp.hasOwnProperty(key)) {
            newObj[key] = tmp[key];
        }
    });
}

function rememberGet(obj) {
    return browser.tabs.get(obj.tabId).then((tab) => {
        // Reconstruct the URL as we did while saving
        let url = parseUri(tab.url);
        url = url.authority + url.path;

        if (urlMemory.has(url)) {
            // Load stored settings
            migratePropObj(obj, urlMemory.get(url));

            // Apply settings
            return applyTabProps(obj);
        } else {
            return undefined;
        }
    });
}

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function reloadTab(obj, forceNocache = false) {
    obj.reloadByAddon = true;

    if ((obj.reqMethod != "GET") && (obj.postConfirmed || Settings.neverConfirmPost)) {
        // Delete old URL from history because our refresh
        // will create a new history entry.
        return browser.history.search({ text: obj.url, maxResults: 1 })
            .then((items) => {
                if (items.length > 0) {
                    let visitTime = items[0].lastVisitTime
                    return browser.history.deleteRange({
                        startTime: visitTime-1,
                        endTime: visitTime+1
                    });
                } else {
                    return true;
                }
            })
            .then(() => {
                obj.keepRefreshing = true;
                let msg = {
                    event: "reload",
                    postData: obj.formData
                };
                return browser.tabs.sendMessage(obj.tabId, msg);
            });
    } else {
        return browser.tabs.reload(obj.tabId, { bypassCache: forceNocache || obj.nocache });
    }
}

function reloadAllTabs() {
    return browser.tabs.query({windowId: CurrentWindowId}).then((tabs) => {
        let promises = [];
        for (let tab of tabs) {
            let obj = getTabProps(tab.id);
            promises.push(reloadTab(obj));
        }

        return Promise.all(promises);
    });
}

// Handle clicking on menu entries
browser.menus.onClicked.addListener(function (info, tab) {
    //    browser.menus.update("reloadmatic-mnu-root", { title: `Tab ID: ${tab.id}` })

    if (info.menuItemId === 'reloadmatic-mnu-settings') {
        browser.runtime.openOptionsPage();
    } else if (info.menuItemId === 'reloadmatic-mnu-faq') {
        browser.tabs.create({
            active: true,
            url: browser.extension.getURL("pages/faq.html")
        });
    } else if (info.menuItemId === 'reloadmatic-mnu-amo') {
        browser.tabs.create({
            active: true,
            url: "https://addons.mozilla.org/en-US/firefox/addon/reloadmatic/"
        });
    } else if (info.menuItemId === 'reloadmatic-mnu-support') {
        browser.tabs.create({
            active: true,
            url: "https://github.com/pylorak/reloadmatic/issues"
        });
    }

    if (tab.id == browser.tabs.TAB_ID_NONE) {
        return
    }
    let obj = getTabProps(tab.id)

    if (info.menuItemId === 'reloadmatic-mnu-period--1') {
        setTabPeriod(obj, -1);
    } else if (info.menuItemId === 'reloadmatic-mnu-period--2') {
        setTabPeriod(obj, -2);
    } else if (info.menuItemId.startsWith("reloadmatic-mnu-period")) {
        setTabPeriod(obj, Number(info.menuItemId.split("-")[3]));
    } else if (info.menuItemId === 'reloadmatic-mnu-randomize') {
        obj.randomize = info.checked
        rememberSet(obj);
    } else if (info.menuItemId === 'reloadmatic-mnu-remember') {
        obj.remember = info.checked
        rememberSet(obj);
    } else if (info.menuItemId === 'reloadmatic-mnu-disable-cache') {
        obj.nocache = info.checked
        rememberSet(obj);
    } else if (info.menuItemId === 'reloadmatic-mnu-smart') {
        obj.smart = info.checked
        rememberSet(obj);
    } else if (info.menuItemId === 'reloadmatic-mnu-sticky') {
        obj.stickyReload = info.checked
        rememberSet(obj);
    } else if (info.menuItemId === 'reloadmatic-mnu-unsuccessful') {
        obj.onlyOnError = info.checked
        rememberSet(obj);
        restartAlarm(obj)
    } else if (info.menuItemId === 'reloadmatic-mnu-reload') {
        reloadTab(obj, true);
    } else if (info.menuItemId === 'reloadmatic-mnu-reload-all') {
        reloadAllTabs();
    } else if (info.menuItemId === 'reloadmatic-mnu-enable-all') {
        browser.tabs.query({}).then((tabs) => {
            for (let tab of tabs) {
                let other = getTabProps(tab.id);
                let oldOther = clone(other);
                migratePropObj(other, obj);
                other.postConfirmed = oldOther.postConfirmed;
                setTabPeriod(other, other.period);
            }
        });
    } else if (info.menuItemId === 'reloadmatic-mnu-disable-all') {
        browser.tabs.query({}).then((tabs) => {
            for (let tab of tabs) {
                let obj = getTabProps(tab.id);
                setTabPeriod(obj, -1);
            }
        });
    }

    if (session57Available) {
        browser.sessions.setTabValue(tab.id, "reloadmatic", obj)
    }
});

if (session57Available) {
    browser.tabs.onCreated.addListener((tab) => {
        let tabId = tab.id
        let obj = getTabProps(tabId)
        browser.sessions.getTabValue(tabId, "reloadmatic").then((obj) => {
            if (obj) {
                // Handle restoring settings for an old tab.
                // Tab ID might have changed, so correct for that.
                let alarm_name = objKey(tabId)
                obj.tabId = tabId
                obj.alarmName = alarm_name
                obj.keepRefreshing = true
                state.set(alarm_name, obj)
                applyTabProps(obj)
            }
        })
    })
}

browser.webRequest.onBeforeRequest.addListener((details) => {
    let obj = getTabProps(details.tabId);
    obj.reqMethod = details.method;
    if ((obj.reqMethod != "GET") && details.requestBody) {
        obj.formData = clone(details.requestBody.formData);
    } else {
        obj.formData = null;
    }

    if ((obj.reqMethod != "GET") && !obj.postConfirmed && !Settings.neverConfirmPost) {
        // We just issued a POST-request,
        // and the user didn't yet confirm this.
        // So disable autoreloads.
        obj.period = -1
        applyTabProps(obj)
    }
},
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["requestBody"]
);

browser.alarms.onAlarm.addListener((alarm) => {
    let obj = state.get(alarm.name);

    if (!obj.onlyOnError || obj.loadError) {    // handling "Only if unsuccessful" feature

        // Delay firing alarm until time is freezeUntil,
        // fire otherwise.
        let now = Date.now();
        if (obj.smart && (obj.freezeUntil > now)) {
            let deltaInSeconds = (obj.freezeUntil - now) / 1000;
            browser.alarms.create(obj.alarmName, { delayInMinutes: deltaInSeconds * TIME_FACTOR });
        } else {
            reloadTab(obj);
        }   // smart
    }   // if onlyOnError ...
});

function sendContentTabId(tabId) {
    let msg = {
        event: "set-tab-id",
        tabId: tabId
    }
    return browser.tabs.sendMessage(tabId, msg)
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId == browser.tabs.TAB_ID_NONE) {
        return;
    }

    let obj = getTabProps(tabId)

    // Tell content-script what tab it is running in
    sendContentTabId(tabId)

    // Start or stop alarm based on page loading progress
    if ('status' in changeInfo) {
        if (changeInfo.status === 'complete') {
            // Scroll page to same position as before reload
            if (obj.reloadByAddon && (obj.scrollX != undefined)) {
                let msg = {
                    event: "scroll",
                    scrollX: obj.scrollX,
                    scrollY: obj.scrollY
                }
                browser.tabs.sendMessage(tabId, msg)
            }

            obj.reloadByAddon = false;

            // Start reload timer once page is completely loaded
            restartAlarm(obj)
        } else {
            // Don't autoreload while page is being loaded
            browser.alarms.clear(obj.alarmName)
        }
    }

    // "Pinning sets Remember" option
    if (Settings.pinSetsRemember && ('pinned' in changeInfo)) {
        obj.remember = changeInfo.pinned;
        rememberSet(obj);
        refreshMenu();
    }
});

browser.webNavigation.onCommitted.addListener((details) => {
    // Remove alarm if tab navigated due to a user action
    if (details.frameId == 0) {
        let tabId = details.tabId
        let obj = getTabProps(tabId)
        let type = details.transitionType
        let reloading = !((type != "auto_subframe") && (type != "reload"))
        let cancelTimer = !reloading && !obj.keepRefreshing && !obj.stickyReload
        if (!reloading) {
            obj.remember = false;
        }
        if (cancelTimer) {
            // On a user-initiated navigation,
            // we cancel the timer but leave other settings alone
            obj.period = -1
            applyTabProps(obj)
                .then(() => rememberGet(obj));
        } else {
            rememberGet(obj);
        }

        // If the URL changed, forget scroll position in tab
        if (obj.url != details.url) {
            obj.scrollX = undefined;
            obj.scrollY = undefined;
            obj.url = details.url;
        }
    }
});

browser.webNavigation.onCompleted.addListener((details) => {
    // Remove alarm if tab navigated due to a user action
    if (details.frameId == 0) {
        let tabId = details.tabId
        let obj = getTabProps(tabId)
        obj.keepRefreshing = false
    }
});

function freezeReload(tabId, duration) {
    let obj = getTabProps(tabId)
    obj.freezeUntil = Date.now() + duration
}

browser.runtime.onMessage.addListener((message) => {
    if (message.event == "activity") {
        // If there is some activity in the tab, delay a potential pending reload
        freezeReload(message.tabId, 3000)
    } else if (message.event == "set-tab-interval") {
        setTabPeriod(getTabProps(message.tabId), message.period);
    } else if (message.event == "scroll") {
        // A page is telling us its scroll position
        let obj = getTabProps(message.tabId)
        obj.scrollX = message.arg1;
        obj.scrollY = message.arg2;
    }
})

browser.tabs.onActivated.addListener((info) => {
    // Delay reload on activity
    freezeReload(info.tabId, 5000)

    // Update menu for newly activated tab
    refreshMenu(info.tabId)
})

browser.windows.onFocusChanged.addListener((windowId) => {
    CurrentWindowId = windowId

    browser.tabs.query({ windowId: CurrentWindowId, active: true }).then((tabs) => {
        if (tabs.length > 0) {
            let tab = tabs[0];
            freezeReload(tab.id, 3000)
            return refreshMenu(tab.id)
        }
    })
})


/***********************************************
* Following functions used for "Only if unsuccessful" feature
***********************************************/

function webRequestError(responseDetails) {
    let tabId = responseDetails.tabId
    let obj = getTabProps(tabId)
    obj.loadError = true
}
function webRequestComplete(responseDetails) {
    let tabId = responseDetails.tabId
    let obj = getTabProps(tabId)
    obj.loadError = (responseDetails.statusCode >= 400)
}
browser.webRequest.onErrorOccurred.addListener(webRequestError, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] })
browser.webRequest.onCompleted.addListener(webRequestComplete, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] })


/***********************************************
* Following functions are used for updating the menu
***********************************************/

function disablePeriodMenus() {
    let promises = [];
    for (let i = 0; i < num_periods / 2; i++) {
        promises.push(
            browser.menus.update(
                `reloadmatic-mnu-period-${reload_periods[i * 2]}`,
                {
                    checked: false,
                    title: reload_periods[i * 2 + 1]
                }
            )
        );
    }
    return Promise.all(promises);
}

function formatInterval(total) {
    let ret = ""
    let h = Math.floor(total / 3600)
    total -= h * 3600
    let m = Math.floor(total / 60)
    total -= m * 60
    let s = total

    if (h > 0) {
        ret = `${ret} ${h}h`
    }
    if (m > 0) {
        ret = `${ret} ${m}m`
    }
    if (s > 0) {
        ret = `${ret} ${s}s`
    }

    if ((h != 0) && (m == 0) && (s == 0)) {
        ret = ` ${h} hours`
    } else if ((h == 0) && (m != 0) && (s == 0)) {
        ret = ` ${m} minutes`
    } else if ((h == 0) && (m == 0) && (s != 0)) {
        ret = ` ${s} secs`
    }

    return ret
}

function menuSetActiveTab(tabId) {
    let obj = getTabProps(tabId);
    disablePeriodMenus()
        .then(() => browser.tabs.get(tabId))
        .then((tab) => {

            let promises = [];

            // Iterate through available presets to see if our setting
            // corresponds to one of them or maybe it's a custom interval.
            let custom = true
            for (let i = 0; i < num_periods / 2; i++) {
                if (reload_periods[i * 2] === obj.period) {
                    custom = false
                    break;
                }
            }

            if (custom) {
                promises.push(browser.menus.update(`reloadmatic-mnu-period--2`, { checked: true, title: `Custom:${formatInterval(obj.period)}` }));
            } else {
                promises.push(browser.menus.update(`reloadmatic-mnu-period-${obj.period}`, { checked: true }));
            }

            if (tab.incognito) {
                promises.push(browser.menus.update("reloadmatic-mnu-remember", { checked: false, enabled: false }));
            } else {
                promises.push(browser.menus.update("reloadmatic-mnu-remember", { checked: obj.remember, enabled: true }));
            }
            promises.push(browser.menus.update("reloadmatic-mnu-randomize", { checked: obj.randomize }));
            promises.push(browser.menus.update("reloadmatic-mnu-unsuccessful", { checked: obj.onlyOnError }));
            promises.push(browser.menus.update("reloadmatic-mnu-smart", { checked: obj.smart }));
            promises.push(browser.menus.update("reloadmatic-mnu-sticky", { checked: obj.stickyReload }));
            promises.push(browser.menus.update("reloadmatic-mnu-disable-cache", { checked: obj.nocache }));

            return Promise.all(promises);
        });
}

function refreshMenu() {
    // We take this path if we don't know the current tab id
    return browser.tabs.query({ currentWindow: true, active: true }).then((tabs) => {
        let tab = tabs[0];
        CurrentWindowId = tab.windowId
        return menuSetActiveTab(tab.id);
    });
}

browser.runtime.onUpdateAvailable.addListener((details) => {
    let upgradeInfo = {
        version: CONFIG_VERSION,
        state: [...state]
    };
    browser.storage.local.set({ upgrade: upgradeInfo }).then(() => {
        browser.runtime.reload();
    });
});

function LoadSettingsAsync() {
    return Promise.resolve()
        .then(() => {
            return browser.storage.local.get("settings")
        }).then((results) => {
            if (results && results.settings) {
                Settings = results.settings;
                return Settings;
            } else {
                throw null;
            }
        }).catch(() => {
            Settings = {
                defaults: {
                    randomize: false,
                    onlyOnError: false,
                    smart: true,
                    stickyReload: false,
                    nocache: false
                },
                pinSetsRemember: true,
                neverConfirmPost: false
            };
            return Settings;
        });
}

function on_addon_load() {

    LoadSettingsAsync()
        .then(() => browser.storage.local.get("upgrade"))
        .then((results) => {

            let upgrading = false;

            if (results && results.upgrade) {
                if (results.upgrade.version <= CONFIG_VERSION) {

                    let newState = new Map(results.upgrade.state)

                    for (var [key, obj] of newState) {

                        // Migrate settings from old version
                        let newObj = newTabProps(obj.tabId);
                        migratePropObj(newObj, obj);
                        state.set(newObj.alarmName, newObj);

                        // Reapply timers
                        setTabPeriod(newObj, newObj.period);
                    }

                    upgrading = true;
                }
            }

            return upgrading;
        })
        .catch(() => Promise.resolve(false))
        .then((upgrading) => {
            // Remove stuff that we only needed for the upgrade
            browser.storage.local.remove("upgrade")

            browser.storage.local.get("urlMemory")
                .then((results) => {
                    let p = browser.tabs.query({});
                    if (results && results.urlMemory) {
                        urlMemory = new Map(results.urlMemory);
                    }
                    return p;
                })
                .then((tabs) => {
                    let promises = [];
                    for (let tab of tabs) {
                        promises.push(
                            // Our content-script is only automatically loaded to new pages.
                            // This means we need to load our content script at add-on load time
                            // manually to all already open tabs.
                            browser.tabs.executeScript(tab.id, { file: "/content-script.js" }).then((result) => {
                                sendContentTabId(tab.id)
                            })
                        );

                        let obj = getTabProps(tab.id);
                        if (!upgrading) {
                            // Already loaded tabs might be using POST *sigh*
                            // We can't just use POST in this case
                            // because if the page is using GET, POSTing might
                            // be completely disallowed. So we'll fall back to
                            // browser reload, but say that the user has
                            // already confirmed POST. This way the browser
                            // might show a popup, but ReloadMatic will then
                            // see it was a POST, and at least won't ask a
                            // second time by itself.
                            obj.reqMethod = "GET";
                            obj.postConfirmed = true;
                        }
                        promises.push(rememberGet(obj));
                    }
                    return Promise.all(promises);
                })
                .then(() => {
                    // Update menu to show status of active tab in current window
                    refreshMenu();
                })
        });
}

on_addon_load()
