﻿"use strict";

const request = require("request");
const argv = require('yargs').argv;
const fs = require('fs');
const path = require('path');
const dateFormat = require('dateformat');
const admin = require("firebase-admin");

const STEAM_INVENTORY_API_URL = "https://steamcommunity.com/inventory/$user_id$/730/2";
const STEAM_PRICE_API_URL = "https://steamcommunity.com/market/priceoverview";

const SAVE_FILE = "files/data.json";
const CONFIG_FILE = "config.cfg";
const FIREBASE_FILE = "serviceAccountKey.json";

const REGEX_NAME = /(.*?) (\d{4}) (.*?) Souvenir Package$/;
const REGEX_MATCH = /^It was dropped during the (.*?) match between (.*?) and (.*?),/;

function sendFirebaseMessage(key, data)
{
    admin.messaging().sendToDevice(key, {data: data})
        .then(function(response) {
            //console.log("Successfully sent message:", response);
        })
        .catch(function(error) {
            console.log("Error sending message:", error);
        });
}

function callSteamApi(userId, count, callback)
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
            log("Error: " + body, {
                bright: true,
                fg_color: "\x1b[37m",
                bg_color: "\x1b[41m"
            })
        }
    });
}

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
            callback(json.lowest_price);
        }
        else
        {
            callback("0");
        }
    })
}

function run()
{
    log("Refreshing...", {bright: true});

    const data = readData();
    const users = readUsers();

    for(let i = 0; i < users.length; i++)
    {
        const userId = users[i]["steam_id"];
        const username = users[i]["username"];
        const key = users[i]["key"];
        const newUser = data[userId] === undefined;

        callSteamApi(userId, 5000, function(response)
        {
            let items = response.descriptions;
            let assets = response.assets;
            let savedItems = data[userId];
            if(savedItems === undefined || savedItems === null)
                savedItems = {};
            data[userId] = {};
            for(let i = 0; i < items.length; i++)
            {
                const name = items[i].name;
                const marketName = items[i].market_hash_name;
                const assetId = getAssetId(assets, items[i].classid, items[i].instanceid);
                const nameMatch = REGEX_NAME.exec(name);
                if(nameMatch !== null)
                {
                    data[userId][assetId] = name;
                    if(!savedItems.hasOwnProperty(assetId))
                    {
                        if(!newUser)
                        {
                            const matchInfo = getMatchInfo(items[i].descriptions);
                            getItemPrice(marketName, function(price)
                            {
                                sendFirebaseMessage(key, {
                                    username: username,
                                    price: price,
                                    team1: matchInfo.team1,
                                    team2: matchInfo.team2,
                                    event: nameMatch[1],
                                    year: nameMatch[2],
                                    map: nameMatch[3],
                                    url: "https://steamcommunity.com/profiles/"+userId+"/inventory#730_2_"+assetId
                                });
                                saveData(JSON.stringify(data));
                                log(username + " just got a package from " + nameMatch[3] + " worth " +
                                    price.replace("€", " euros").replace("$", "dollars"), {
                                    fg_color: "\x1b[32m",
                                    bright: true
                                });
                            });
                        }
                        else
                        {
                            saveData(JSON.stringify(data));
                            log(username + " already had a " +
                                nameMatch[1] + " " + nameMatch[2] + " " + nameMatch[3] + ", not notifying",
                                {
                                    fg_color: "\x1b[33m",
                                    bright: true
                                }
                            );
                        }
                    }
                }
            }
        });
    }
}

function readData()
{
    try
    {
        return JSON.parse(fs.readFileSync(SAVE_FILE, "utf-8"));
    }
    catch(e)
    {
        ensureDirectoryExistence(SAVE_FILE);
        fs.writeFileSync(SAVE_FILE, "{}", "utf-8");
        return {};
    }
}


function saveData(data)
{
    fs.writeFileSync(SAVE_FILE, data, "utf-8");
}

function readUsers()
{
    const users = [];
    const lines = fs.readFileSync(CONFIG_FILE, "utf-8").split("\n");

    for(let i = 0; i < lines.length; i++)
    {
        const content = lines[i].split(" ");
        users.push({steam_id: content[1], key: content[2], username: content[0]});
    }

    return users;
}

function ensureDirectoryExistence(filePath)
{
    const dirname = path.dirname(filePath);
    if(fs.existsSync(dirname))
    {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

function startupText(delay)
{
    const users = readUsers();
    const data = readData();

    let usersText = "[ ";
    for(let i = 0; i < users.length; i++)
    {
        if(i !== 0)
            usersText += ", ";
        usersText += users[i].username;
    }
    usersText += " ]";
    log("Starting souvenir-notifier by RouNdeL, refresh time is set to " + delay + " minutes",
        {
            bright: true,
            fg_color: "\x1b[37m",
            bg_color: "\x1b[46m"
        });
    log("Configured users are " + usersText,
        {
            bright: true,
            fg_color: "\x1b[37m",
            bg_color: "\x1b[46m"
        });
    for(let i = 0; i < users.length; i++)
    {
        if(data[users[i].steam_id] !== undefined)
        {
            let count = Object.keys(data[users[i].steam_id]).length;
            log(users[i].username + " already has " + count + " Souvenir Package" + (count === 1 ? "s" : ""),
                {
                    bright: true,
                    fg_color: "\x1b[37m",
                    bg_color: "\x1b[46m"
                });

        }
    }
}

function start(delay)
{
    initializeFirebase();
    startupText(delay);
    run();
    setInterval(run, delay * 60 * 1000);
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

function initializeFirebase()
{
    //noinspection NpmUsedModulesInstalled
    const serviceAccount = JSON.parse(fs.readFileSync(FIREBASE_FILE));

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://souvenirnotifier.firebaseio.com"
    });
}

function getAssetId(assets, classid, instanceid)
{
    for(let i = 0; i < assets.length; i++)
    {
        if(assets[i].instanceid === instanceid && assets[i].classid === classid)
            return assets[i].assetid;
    }
}

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

if(argv.delay !== undefined)
{
    start(argv.delay);
}
else
{
    start(5);
}