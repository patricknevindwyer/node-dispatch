var express = require('express');
var router = express.Router();
var request = require("request");
var _ = require("underscore");
var async = require("async");
var uuid = require("node-uuid");

/*
            
    Each service is defined by a name and one or more URIs for the
    named service. Each registered service is given a servie token
    that it can use to heartbeat, deregister, or ping the dispatch
    service. 
    
    # Listeners
    
    Each listener can register service names or tags to
    listen for changes to service offerings. The standard API is
    used to poll for updates once a webhook for service change has
    been called.
    
    Listeners can register based on service name, or service tag:
    
    PUT /listen/service/name/<service name>
    PUT /listen/service/tag/<service tag>
        
        BODY:
            {
                "webhook": <URI for webhook callback>
            }
    
    The special case of listening for all tag or name changes can be
    registered with:
    
    PUT /listen/service/all
            
    # Service Information
    
    When a service is polled via the API (for instance 'service-cached-dns'),
    the resulting data structure returned will be of the form:
    
    GET /service/name/<service-name>
        
        RETURNS:
        
            {
                "service": "service-cached-dns",
                "endpoints": [
                    {
                        "endpoint": "http://localhost:8000/service",
                        "uuid": <service uuid>
                    }
                ]
            }
    
    or for tag based lookup:
    
    GET /service/tag/<service-tag>
        
        RETURNS: 
            {
                "tag": "service tag",
                "endpoints": [
                    {
                        "endpoint": "http://localhost:8000/service",
                        "uuid": <service uuid>
                    }
                ]
            }
    
    or for UUID based lookup, retrieving more information about a specific service:
    
    GET /service/uuid/<service-uuid>
        
        RETURNS:
            {
                "uuid": <>,
                "endpoint": <uri>,
                "age": <seconds alive>,
                "heartbeat": <seconds since heartbeat>,
                "tags": [],
                "ttl": <seconds to live before reaping>,
                "service": <service name>
            }
    
    For cases where a full copy of current configuration is useful, you can also request
    the entire set of service data
    
    GET /service/all
        
        RETURNS:
            
            {
                providers: {
                    <uuid>: {
                        "endpoint": <uri>,
                        "age": <seconds alive>,
                        "heartbeat": <seconds since heartbeat>,
                        "tags": [],
                        "service": <name of service>,
                        "ttl": <seconds to live before reaping>
                    }
                },
                
                tags: {
                    <tag>: [<uuid>, <uuid>, ...]
                },
                
                service: {
                    <name>: [<uuid>, <uuid>, ...]
                }
            }
    
    # Webhooks
            
    Listeners are notified via a GET webhook of the form:
    
        <webhook URI base>/service-name
    
    or:
        
        <webhook URI base>/service-tag
    
    depending on whether the listener registered as a name or tag listener. After receiving 
    the webhook, listeners can use the already identified methods above to retrieve config
    data.
    
    If a listener has registered for the "all" messages, the webhook will be of the form:
    
        <webhook URI base>/all
    
    # Services
    
    Services can interact with the following methods:
    
    PUT /register
        BODY:
            
            {
                "service": <service-name>,
                "endpoint": <base endpoint>,
                "tags": ["dns", "ip", ...]
            }
            
        RETURNS:
            UUID
    
    DELETE /service/uuid/<uuid>
    
    PUT /service/uuid/<uuid>/heartbeat
     

*/

// Primary service name to service UUIDs mapping
// Each entry has the form:
//      "<service-name>": ["service-uuid", ...]

var SERVICE_TO_UUID = {};

// Track service endpoints by registered TAGs
var TAG_TO_UUID = {};

// Mapping of the UUID to the configuration entry for a service
// endpoint. Each entry has the form:
//      "<service-uuid>": {"endpoint": <uri>, "last-heartbeat": <long long>, "first-heartbeat": <long long>}
var UUID_TO_CONFIG = {};

// Listeners that register by service tag
var LISTENERS_BY_TAG = {};

// Listeners that register by service name
var LISTENERS_BY_NAME = {};

// Listeners that register for all events
var LISTENERS_ALL = [];

/*
    Register a new service listener as a name or tag based listener
*/
router.put(/\/listen\/service\/(name|tag)\/([a-zA-Z0-9\-]+)\/?$/, function (req, res, next) {
    
    var selector = req.params[0];
    var id = req.params[1];
    var hook = req.body.webhook;
    
    if (selector === "name") {
        if (!_.has(LISTENERS_BY_NAME, id)) {
            LISTENERS_BY_NAME[id] = [];
        }
        LISTENERS_BY_NAME[id].push(hook);
    }
    else if (selector === "tag") {
        if (!_.has(LISTENERS_BY_TAG, id)) {
            LISTENERS_BY_TAG[id] = [];
        }
        LISTENERS_BY_TAG[id].push(hook);
    }
    
    res.json({error: false, msg: "ok"});
});

/*
    Register a new service listener that gets all notifications
*/
router.put("/listen/service/all", function (req, res, next) {
    var hook = req.body.webhook;
    LISTENERS_ALL.push(hook);

    res.json({error: false, msg: "ok"});
});

/*
    For easy cases, grab the service name and tags from an object
*/
function notifyByObject(serviceObject, next) {
    
    async.series(
        [
            // name based notifier
            function (callback) {
                console.log("NOTIFY//name");
                
                notifyForService(LISTENERS_BY_NAME, serviceObject.service,
                function () {
                    callback(null, serviceObject.service);
                })
            },
            
            // tag based notifier
            function (callback) {
                console.log("NOTIFY//tags");
                
                async.map(
                    serviceObject.tags,
                    
                    function (tag, cb) {
                        notifyForService(LISTENERS_BY_TAG, tag,
                        function () {
                            cb(null, tag)
                        })
                    },
                    
                    function (err, results) {
                        callback(null, results);
                    }
                );
            },
            
            // ALL notifier
            function (callback) {
                console.log("NOTIFY//all");
                notifyForAll(
                    function () {
                        callback(null, "all");
                    }
                )
            }
            
        ],
        
        function (err, results) {
            console.log("NOTIFY//complete");
            next(null, "ok");
        }
    )
}

/*
    Send notifications to all listeners for a specific service name or tag name. This would
    be called as:
        
        notifyForService(LISTENERS_BY_NAME, "whois");
    
    or:
    
        notifyForService(LISTENERS_BY_TAG, "dns");
        
*/
function notifyForService(LISTENER_GROUP, serviceId, finish) {
    
    if (_.has(LISTENERS_BY_NAME, serviceId)) {
        async.map(
            LISTENERS_BY_NAME[serviceId],
            
            // ping the listener
            function (listener, next) {
                
                // normalize the webhook
                var fullWebhook = listener;
                if (!fullWebhook.endsWith("/")) {
                    fullWebhook += "/";
                }
                fullWebhook += serviceId;
                
                request(fullWebhook,
                    function (err, res, body) {
                        if (err) {
                            console.log("Error with webhook [%s] code %d", err, res.statusCode);
                        }
                        next(null, fullWebhook);
                    }
                );
            },
            
            function (err, results) {
                console.log("Pinged %d webhooks for service id [%s]", results.length, serviceId);
                finish();
            }
        )
    }
}

/*
    Let the "all" listeners know that something has changed
*/
function notifyForAll(finish) {
    
    async.map(
        LISTENERS_ALL,
        
        // ping the listener
        function (listener, next) {
            // normalize the webhook
            var fullWebhook = listener;
            if (!fullWebhook.endsWith("/")) {
                fullWebhook += "/";
            }
            fullWebhook += "all";
            
            request(fullWebhook,
                function (err, res, body) {
                    if (err) {
                        console.log("Error with webhook [%s] code %d", err, res.statusCode);
                    }
                    next(null, fullWebhook);
                }
            );
            
        },
        
        function (err, results) {
            console.log("Pinged %d listeners for an ALL change", results.length);
            finish();
        }
    )
}

/*
    Register a new service via the dispatch. Maps the service to its declared service
    name support as well as zero or more service tags.
*/
router.put("/register", function (req, res, next) {
    var configBlob = req.body;
    var serviceUUID = uuid.v4();
    console.log("config blob raw");
    console.log(configBlob);
    
    console.log("REGISTER\n\tservice: %s\n\tendpiont: %s\n\ttags: %s", configBlob.service, configBlob.endpoint, configBlob.tags.join(","))
    console.log("\tuuid: %s", serviceUUID);
    
    // setup the various time trackers
    configBlob.created = Date.now();
    configBlob.heartbeat = Date.now();
    
    // assign to the config structure
    UUID_TO_CONFIG[serviceUUID] = configBlob;
    
    // map to the service and tag sections
    if (!_.has(SERVICE_TO_UUID, configBlob.service)) {
        SERVICE_TO_UUID[configBlob.service] = [];
    } 
    SERVICE_TO_UUID[configBlob.service].push(serviceUUID)
    
    // map to the tags
    _.each(configBlob.tags, function (tag) {
        if (!_.has(TAG_TO_UUID, tag)) {
            TAG_TO_UUID[tag] = [];
        }
        TAG_TO_UUID[tag].push(serviceUUID);
    });
    
    // send notifications to any listeners
    notifyByObject(configBlob,
        function (err, results) {
    
            // return the service UUID
            res.json({error: false, uuid: serviceUUID});
            
        }
    );
});

/*
    Delete the given service
*/
router.delete(/\/service\/uuid\/([a-zA-Z0-9\-]+)\/?$/, function (req, res, next) {
    var serviceUUID = req.params[0];
    
    if (_.has(UUID_TO_CONFIG, serviceUUID)) {
        // grab the service details
        var serviceName = UUID_TO_CONFIG[serviceUUID].service;
        var serviceTags = UUID_TO_CONFIG[serviceUUID].tags;
        
        // unlink the mappings
        SERVICE_TO_UUID[serviceName] = _.without(SERVICE_TO_UUID[serviceName], serviceUUID);
        _.each(serviceTags, function (tag) {
            TAG_TO_UUID[tag] = _.without(TAG_TO_UUID[tag], serviceUUID);
        })
        
        // remove the top level config
        var configBlob = UUID_TO_CONFIG[serviceUUID];
        delete UUID_TO_CONFIG[serviceUUID];
        
        // Send notifications
        notifyByObject(configBlob,
            function (err, results) {
        
                // return the service UUID
                res.json({error: false, msg: "service removed from dispatch"});
                
            }
        );
    }
    else {
        res.json({error: true, msg: "No such service UUID registered"});
    }
    
});

/*
    Heartbeat is a PATCH call
*/
router.patch(/\/service\/uuid\/([a-zA-Z0-9\-]+)\/heartbeat\/?$/, function (req, res, next) {
    var serviceUUID = req.params[0];
    console.log("Received heartbeat for [%s]", serviceUUID);
    
    if (_.has(UUID_TO_CONFIG, serviceUUID)) {
        // update the most recent heartbeat
        UUID_TO_CONFIG[serviceUUID].heartbeat = Date.now();
        
        res.json({error: false, msg: "ok"});
    }
    else {
        res.json({error: true, msg: "No such service UUID registered"});
    }
});


module.exports = router;
