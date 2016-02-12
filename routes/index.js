var express = require('express');
var router = express.Router();
var request = require("request");
var _ = require("underscore");
var async = require("async");
var uuid = require("node-uuid");

/*
    TODO: Basic API for getting a service endpoint by name or list of endpoints
    TODO: Basic callback register for listening for registrations
    TODO: Basic API for registering a service
    TODO: Basic API for service heartbeat
    TODO: Age services
    TODO: Basic callback for aged-out services
    TODO: Wrap service client into a package
            * registration name
            * port resolution
            * hostname resolution
            * auto-heartbeat
            * dereg on exit/bail
            
    Each service is defined by a name and one or more URIs for the
    named service. Each registered service is given a servie token
    that it can use to heartbeat, deregister, or ping the dispatch
    service. 
    
    Each listener can pattern match on a name, or a wild card to
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
    When a service is polled via the API (for instance 'service-cached-dns'),
    the resulting data structure returned will be of the form:
    
    GET /service/name/<service-name>
        
        RETURNS:
        
            {
                "service": "service-cached-dns",
                "endpoints": [
                    {
                        "endpoint": "http://localhost:8000/service",
                        "age": <seconds alive>,
                        "heartbeat": <seconds since heartbeat>,
                        "service-tags": ["dns", "ip", "trace", "headers", ...]
                    }
                ]
            }
    
    or for tag based lookup:
    
    GET /service/tag/<service-tag>
        
        RETURNS: 
            {
                "tag": "service tag",
                "services": [
                    {
                        "service": "service-cache-dns",
                        "endpoints": [
                            {
                                "endpoint": "http://localhost:8000/service",
                                "age": <seconds alive>,
                                "heartbeat": <seconds since heartbeat>,
                                "service-tags": ["dns", "ip", "trace", ...]
                            }
                        ]        
                    }
                ]
            }
        
    Listeners are notified via a GET webhook of the form:
    
        <webhook URI base>/service-name
    
    or:
        
        <webhook URI base>/service-tag
    
    depending on whether the listener registered as a name or tag listener.
    
    Services can interact with the following methods:
    
    PUT /register
        BODY:
            
            {
                "service": <service-name>,
                "endpoint": <base endpoint>,
                "service-tags": ["dns", "ip", ...]
            }
            
        RETURNS:
            UUID
    
    DELETE /service/uuid/<uuid>
    
    PUT /service/uuid/<uuid>/heartbeat
     

*/

// Primary service name to service UUIDs mapping
// Each entry has the form:
//      "<service-name>": ["service-uuid", ...]

var SERVICE_TO_UUID = {
    
}

// Track service endpoints by registered TAGs
var TAG_TO_UUID = {
    
}

// Mapping of the UUID to the configuration entry for a service
// endpoint. Each entry has the form:
//      "<service-uuid>": {"endpoint": <uri>, "last-heartbeat": <long long>, "first-heartbeat": <long long>}
var UUID_TO_CONFIG = {
    
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
    // TODO: TAG change notifications
    // TODO: NAME change notifications
    
    // return the service UUID
    res.json({error: false, uuid: serviceUUID});
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
        delete UUID_TO_CONFIG[serviceUUID];
        
        // we're good
        res.json({error: false, msg: "service removed from dispatch"});
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
