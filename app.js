"use strict";

const request = require("request");
const argv = require('yargs').argv;
const fs = require('fs');
const path = require('path');

const NOTIFY_API_URL = "https://api.simplepush.io/send";
const STEAM_INVENTORY_API_URL = "https://steamcommunity.com/inventory/$user_id$/730/2";
const STEAM_PRICE_API_URL = "https://steamcommunity.com/market/priceoverview";

const SAVE_FILE = "files/data.json";
const CONFIG_FILE = "config.cfg";

const REGEX_SOUVENIR = /(.*) (\d{4}) (.*) Souvenir Package/;

function sendNotification(key, title, message)
{
    request.get({
        url: NOTIFY_API_URL+"/"+key+"/"+title+"/"+encodeURI(message)
    }, (err, response, body) =>
    {
        try{
            let json = JSON.stringify(body);
            if(json.status !== "OK")
            {
                console.log(body)
            }
        }
        catch(e)
        {
            console.log(body)
        }
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
        callback(JSON.parse(body))
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
    })
}

function run()
{
    console.log("Refreshing...");

    const data = readData();
    const users = readUsers();

    for(let i = 0; i < users.length; i++)
    {
        const userId = users[i]["steam_id"];
        const username = users[i]["username"];
        const key = users[i]["key"];
        callSteamApi(userId, 5000, function(response)
        {
            let items = response.descriptions;
            for(let i = 0; i < items.length; i++)
            {
                const name = items[i].name;
                const marketName = items[i].market_hash_name;
                const match = REGEX_SOUVENIR.exec(name);
                if(match !== null)
                {
                    if(data[userId] === undefined)
                        data[userId] = [];
                    if(data[userId].indexOf(name) === -1)
                    {
                        data[userId].push(name);
                        getItemPrice(marketName, function(price)
                        {
                            sendNotification(
                                key,
                                "New item drop for " + username,
                                "You got a Souvenir Package from " + match[3] + " worth " + price
                            );
                            saveData(JSON.stringify(data));
                            console.log(username+" just got a "+name+" worth "+price);
                        });
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

function start(delay)
{
    run();
    setInterval(run, delay*60*1000);
}

if(argv.delay !== undefined)
{
    start(argv.delay);
}
else
{
    start(5);
}