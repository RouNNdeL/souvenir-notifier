"use strict";

const request = require("request");
const argv = require('yargs').argv;
const fs = require('fs');
const path = require('path');
const dateFormat = require('dateformat');
const admin = require("firebase-admin");
const diff = require("deep-object-diff").detailedDiff;

const STEAM_INVENTORY_API_URL = "https://steamcommunity.com/inventory/$user_id$/730/2";
const STEAM_PRICE_API_URL = "https://steamcommunity.com/market/priceoverview";

const SAVE_FILE = "files/data.json";
const FIREBASE_FILE = "serviceAccountKey.json";

const REGEX_NAME = /(.*?) (\d{4}) (.*?) Souvenir Package$/;
const REGEX_MATCH = /^It was dropped during the (.*?) match between (.*?) and (.*?),/;

const LOG_ERROR = {
    bright: true,
    fg_color: "\x1b[37m",
    bg_color: "\x1b[41m"
};

const LOG_WARNING = {
    fg_color: "\x1b[33m",
    bright: true
};

const LOG_HIGHLIGHT = {
    bright: true,
    fg_color: "\x1b[37m",
    bg_color: "\x1b[46m"
};

const LOG_INFO = {
    bright: true
};


const mDelay = argv.delay !== undefined ? argv.delay : argv.d !== undefined ? argv.d : 5;
let mUsers;
let mDbData;
let mInterval = -1;
let mRestart = false;
let mVerbose;
let mRemoteControl;

console.reset = () => process.stdout.write('\x1bc');

/**
 * Sends a FirebaseMessage to a single client
 * @param key - the registration token that comes from the client FCM SDKs.
 * @param data - the payload to send
 */
function sendFirebaseMessage(key, data)
{
    admin.messaging().sendToDevice(key, {data: data})
         .then(response =>
         {
             verbose("Successfully sent message:", response);
         })
         .catch(error =>
         {
             log("Error sending message:" + JSON.stringify(error), LOG_ERROR);
         });
}

/**
 * @callback onInventoryFetchedCallback
 * @param result - an Object return by the Steam API
 */
/**
 * Fetches an inventory of a user given the Steam64ID
 * @param userId - user id in steam64 format
 * @param count - maximum count of items to fetch
 * @param {onInventoryFetchedCallback} callback
 */
function fetchInventory(userId, count, callback)
{
    request({
        url: STEAM_INVENTORY_API_URL.replace("$user_id$", userId),
        qs: {
            l: "english",
            count: count
        }
    }, (err, response, body) =>
    {
        try
        {
            callback(JSON.parse(body))
        }
        catch(e)
        {
            log("Error: " + body, LOG_ERROR)
        }
    });
}


/**
 * @callback onPriceFetchedCallback
 * @param {string} - the lowest price of an item in EUR (ex. 1,23€)
 */
/**
 * Asynchronously fetches a price by the market name
 * @param name - the so called 'market_hash_name' from the Steam API
 * @param {onPriceFetchedCallback} callback
 */
function getItemPrice(name, callback)
{
    //noinspection SpellCheckingInspection
    request({
        url: STEAM_PRICE_API_URL,
        qs: {
            currency: 3,
            appid: 730,
            market_hash_name: name
        }
    }, (err, response, body) =>
    {
        const json = JSON.parse(body);
        if(json.success)
        {
            verbose("Got price for " + name + ": " + json.lowest_price);
            callback(json.lowest_price);
        }
        else
        {
            log("Error getting price for " + name + ": " + response, LOG_ERROR);
            callback("0");
        }
    })
}

/**
 * Main function doing work. It asynchronously calls Steam API
 * to fetch User's inventories, then processes the response
 * and sends the appropriate notifications
 * @param users - users received from the {@link onUsersFetchedCallback()}
 * @see fetchInventory
 * @see getItemPrice
 * @see sendFirebaseMessage
 */
function run(users)
{
    if(mRestart)
    {
        restart();
        return;
    }

    log("Refreshing...", LOG_INFO);

    const data = readData();

    for(let k in users)
    {
        if(!users.hasOwnProperty(k))
            continue;
        const userId = users[k]["steam_id"];
        const username = users[k]["username"];
        const keys = users[k]["keys"];
        const newUser = data[userId] === undefined;

        fetchInventory(userId, 1000, response =>
        {
            if(response === null)
            {
                log("Warning: Failed to fetch inventory for " + username + ", it might be set to private", LOG_WARNING);
                return;
            }
            let items = response.descriptions;
            let assets = response.assets;
            let savedItems = data[userId];
            if(savedItems === undefined || savedItems === null)
                savedItems = [];
            data[userId] = [];
            let anyItems = false;
            verbose("Total inventory count for " + username + ": " + response.total_inventory_count);
            let souvenirs = 0;
            for(let i = 0; i < items.length; i++)
            {
                const name = items[i].name;
                const marketName = items[i].market_hash_name;
                const assetId = getAssetId(assets, items[i].classid, items[i].instanceid);
                const nameMatch = REGEX_NAME.exec(name);
                if(nameMatch !== null)
                {
                    souvenirs++;
                    anyItems = true;
                    data[userId].push(assetId);
                    if(savedItems.indexOf(assetId) === -1)
                    {
                        if(!newUser)
                        {
                            const matchInfo = getMatchInfo(items[i].descriptions);
                            getItemPrice(marketName, price =>
                            {
                                for(let j = 0; j < keys.length; j++)
                                {
                                    sendFirebaseMessage(keys[j], {
                                        username: username,
                                        price: price,
                                        team1: matchInfo.team1,
                                        team2: matchInfo.team2,
                                        event: nameMatch[1],
                                        year: nameMatch[2],
                                        map: nameMatch[3],
                                        url: "https://steamcommunity.com/profiles/" + userId + "/inventory#730_2_" + assetId
                                    });
                                }
                                saveData(data);
                                log(username + " just got a package from " + nameMatch[3] + " worth " +
                                    price.replace("€", " euros").replace("$", "dollars"), {
                                    fg_color: "\x1b[32m",
                                    bright: true
                                });
                            });
                        }
                        else
                        {
                            saveData(data);
                            log(username + " already had a " +
                                nameMatch[1] + " " + nameMatch[2] + " " + nameMatch[3] + ", not notifying",
                                LOG_WARNING
                            );
                        }
                    }
                }
            }
            if(!anyItems)
            {
                saveData(data);
            }
            verbose("Souvenir Package count for " + username + ": " + souvenirs);
        });
    }
}

/**
 * Reads the data about Steam Users' packages from a file in local directory
 * @returns {{}}
 * @see SAVE_FILE
 */
function readData()
{
    try
    {
        return JSON.parse(fs.readFileSync(SAVE_FILE, "utf-8"));
    }
    catch(e)
    {
        verbose("File " + SAVE_FILE + " doesn't exist, creating it");
        ensureDirectoryExistence(SAVE_FILE);
        fs.writeFileSync(SAVE_FILE, "{}", "utf-8");
        return {};
    }
}

/**
 * Saves data about Steam Users' packages to a file in local directory
 * @param {string|object} data
 * @see SAVE_FILE
 */
function saveData(data)
{
    verbose("Saving data for " + Object.keys(data).length + " steam account(s)");
    if(typeof data === "string")
        fs.writeFileSync(SAVE_FILE, data, "utf-8");
    else
        fs.writeFileSync(SAVE_FILE, JSON.stringify(data), "utf-8");
}

/**
 * @callback onUsersFetchedCallback
 * @param {{id: {steam_id: number, username: string, keys: [string]}}} users - fetched users
 */
/**
 * Asynchronously fetches users from the Firebase Database
 * @param {onUsersFetchedCallback} callback
 */
function readUsersFromDatabase(callback)
{
    const db = admin.database();
    db.ref("data").child("users").once("value", data =>
    {
        const val = data.val();
        mDbData = val;
        const users = {};
        for(let k in val)
        {
            if(!val.hasOwnProperty(k))
                continue;
            let user = val[k];
            let steamAccounts = user.steamAccounts;
            for(let l in steamAccounts)
            {
                //noinspection JSUnfilteredForInLoop
                if(!users.hasOwnProperty(l))
                {
                    //noinspection JSUnfilteredForInLoop
                    users[l] = {
                        username: steamAccounts[l],
                        steam_id: l,
                        keys: []
                    }
                }
                //noinspection JSUnfilteredForInLoop
                users[l].keys.push(user.token);
            }
        }


        verbose("Loaded " + Object.keys(val).length + " app user(s)");
        verbose("Loaded " + Object.keys(users).length + " Steam account(s)");

        callback(users);
    });
}

/**
 * Checks whether a directory exists and and creates it if it doesn't
 * @param filePath - a path to a file that we want to create in said directory
 * @returns {void}
 */
function ensureDirectoryExistence(filePath)
{
    const dirname = path.dirname(filePath);
    if(fs.existsSync(dirname))
    {
        return;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

/**
 * Prints the startup text to the console
 * @param users - required to properly print the text
 */
function startupText(users)
{
    const data = readData();
    let usersText = "[ ";
    let keys = Object.keys(users);
    for(let i = 0; i < keys.length; i++)
    {
        if(i !== 0)
            usersText += ", ";
        usersText += users[keys[i]].username;
    }
    usersText += " ]";
    log("Fetched users from Database " + usersText, LOG_HIGHLIGHT);
    for(let i = 0; i < keys.length; i++)
    {
        if(data[keys[i]] !== undefined)
        {
            let count = Object.keys(data[keys[i]]).length;
            if(count > 0)
            {
                log(users[keys[i]].username + " already has " + count +
                    " Souvenir Package" + (count === 1 ? "s" : ""), LOG_HIGHLIGHT);
            }

        }
    }
}

function log(text, options, includeDate = true)
{
    let brightness;
    let bg_color = "";
    let fg_color = "";
    if(options && options.bright)
        brightness = "\x1b[1m";
    else
        brightness = "\x1b[2m";
    if(options && options.fg_color)
        fg_color = options.fg_color;
    if(options && options.bg_color)
        bg_color = options.bg_color;

    const date = dateFormat(new Date(), "yyyy-mm-dd HH:MM:ss");
    console.log(brightness + bg_color + fg_color + "%s" + "\x1b[0m", (includeDate ? date + " - " : "") + text);
}

function verbose(text)
{
    if(mVerbose)
    {
        const date = dateFormat(new Date(), "yyyy-mm-dd HH:MM:ss");
        console.log(date + " - V: " + text);
    }
}

/**
 * Initializes the 'firebase-admin' module as described in the
 * {@link https://firebase.google.com/docs/admin/setup#initialize_the_sdk Docs}
 */
function initializeFirebase()
{
    //noinspection NpmUsedModulesInstalled
    const serviceAccount = JSON.parse(fs.readFileSync(FIREBASE_FILE));

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://souvenirnotifier.firebaseio.com"
    });
}

/**
 * Registers a listener that will restart the app if any changes take place
 * in <code>users</code> Database reference
 */
function registerOnUpdateListener()
{

    const db = admin.database();
    db.ref("data").on("child_changed", data =>
    {
        mRestart = true;
        log("Database updated, restarting on next refresh...", LOG_INFO);

        let value = diff(mDbData, data.val());
        mDbData = data.val();
        verbose("Difference in Database:\n" + JSON.stringify(value, null, 4));
    });
}

function registerOnServerStateListener()
{
    const db = admin.database();
    db.ref("config").child("server_remote_control_enabled").set(true);
    let callback = data =>
    {
        verbose("Config change detected: { " + data.key + ": " + data.val() + " }");
        if(data.key === "server_trigger")
            if(data.key === "server_trigger")
            {
                if(mInterval === -1 && data.val() === true)
                {
                    verbose("Starting server as requested by remote control");
                    start();
                }
                else if(mInterval !== -1 && data.val() === false)
                {
                    verbose("Stopping server as requested by remote control");
                    console.reset();
                    log("Server is now in idle mode, waiting to receive a startup command", LOG_HIGHLIGHT);
                    stop();
                }
                db.ref("config").child("server_trigger").set(null);
            }
    };
    db.ref("config").on("child_added", callback);
}

function updateServerState()
{
    const db = admin.database();
    db.ref("config").child("server_running").set(mInterval !== -1);
    db.ref("config").child("server_online").set(true);
}

/**
 * Used to get an asset from two params that allow to uniquely (presumably, not certain) identify an asset
 * @param assets - a list of assets return from the Steam API
 * @param classid - a parameter present in both 'asset' and 'description'
 * @param instanceid - a parameter present in both 'asset' and 'description'
 * @returns {string}
 */
function getAssetId(assets, classid, instanceid)
{
    for(let i = 0; i < assets.length; i++)
    {
        if(assets[i].instanceid === instanceid && assets[i].classid === classid)
            return assets[i].assetid;
    }
}

/**
 * Loops through the descriptors to find one that describes a match,
 * during which the Souvenir Package was dropped
 * @param descriptors
 * @returns {null|{tier: string, team1: string, team2: string}}
 */
function getMatchInfo(descriptors)
{
    for(let i = 0; i < descriptors.length; i++)
    {
        const match = REGEX_MATCH.exec(descriptors[i].value);
        if(match !== null)
        {

            return {
                tier: match[1],
                team1: match[2],
                team2: match[3]
            }
        }
    }

    return null;
}

function checkInternetConnection(callback)
{
    //noinspection JSUnusedLocalSymbols
    request({
        url: "https://gstatic.com/generate_204"
    }, (err, response, body) =>
    {
        if((err !== null && response === undefined) ||
            (response !== undefined && response !== null && response.statusCode !== 204))
        {
            log("Error: The server requires an active internet connection", LOG_ERROR);
            process.exit();
        }
        else
        {
            callback();
        }
    });
}

/**
 * Main function of the script, initializes an interval that fires every n seconds
 * @see run
 * @see readUsersFromDatabase
 * @see startupText
 */
function start()
{
    console.reset();
    verbose("Arguments:\n" + JSON.stringify(argv, null, 4));
    log("Starting souvenir-notifier by RouNdeL, refresh time is set to " + mDelay + " minutes", LOG_HIGHLIGHT);
    log("Successfully initialized Firebase", LOG_HIGHLIGHT);

    readUsersFromDatabase(users =>
    {
        mUsers = users;
        startupText(users);
        run(users);
        mInterval = setInterval(() => {checkInternetConnection(run.bind(mUsers));}, mDelay * 60 * 1000);
        updateServerState();
    });
}

/**
 * Restarts the app, clearing the run() interval
 */
function restart()
{
    mRestart = false;
    stop();
    start();
}

function stop()
{
    clearInterval(mInterval);
    mInterval = -1;
    updateServerState();
}

function init()
{
    mVerbose = argv.verbose === true || argv.v === true;
    mRemoteControl = argv.remoteControl === true || argv.r === true;

    initializeFirebase();
    registerOnUpdateListener();
    updateServerState();

    if(argv.idle !== true && !mRemoteControl)
    {
        start();
    }
    else
    {
        log("Server is now in idle mode, waiting to receive a startup command", LOG_HIGHLIGHT);
    }

    if(mRemoteControl)
    {
        verbose("Remote control enabled");
        registerOnServerStateListener();
    }

    process.on('SIGINT', () =>
    {
        log("Shutting down server", LOG_HIGHLIGHT);
        setTimeout(() => {process.exit()}, 10000);
        const db = admin.database();
        db.ref("config").off();
        db.ref("data").off();
        db.ref("config").child("server_running").set(false);
        db.ref("config").child("server_remote_control_enabled").set(null);
        db.ref("config").child("server_online").set(false, () => {process.exit();});
    });
}

checkInternetConnection(init);