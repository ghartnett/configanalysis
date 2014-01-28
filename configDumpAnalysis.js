// This script does some analysis of typical config db dump

conn = new Mongo()
db = conn.getDB("config") 
// day is the interval for creating changlog "movie"
day = 1000*60*60*24 

// clean up
db.movie.drop()
db.summary.drop()

//basics
numShards = db.shards.find().count()



//Basic Collection Info
collections = 
    db.collections.aggregate( 
	{ $match : { "dropped" : false }},
	{ $group : { 
	    _id : { "collection": "$_id", "unique shard key" : "$unique" }
	}})
numLiveCollections = db.collections.find({"dropped":false}).count()

// Chunks Per Collection
chunksPerCollection = 
    db.chunks.aggregate(
	{ $group : {
	    _id : "$ns",
	    "chunk count" : { $sum : 1 }
	}})

// Chunks per Shard
chunksPerShard = 
    db.chunks.aggregate(
	{ $group : {
	    _id : "$shard",
	    "chunk count" : { $sum : 1 }
	}})

// Chunks per collection per shard
chunks = 
    db.chunks.aggregate(
	{ $group : {
	    _id : {collection: "$ns", shard: "$shard"},
	    "chunkCount" : { $sum : 1 }
	}})

// Examine changelog to illustrate how much time it covers
changelog = 
    db.changelog.aggregate(
	{ $group: {
	    _id : 0,
	    "minTime" : { $min : "$time" },
	    "maxTime" : { $max : "$time" }
	}})
beginTime = new Date(changelog.result[0].minTime)
endTime = new Date(changelog.result[0].maxTime)
diff = (endTime.getTime() - beginTime.getTime())/day

// histogram of "what" entries in changelog
changelog = 
    db.changelog.aggregate(
	{ $group: {
	    _id : "$what",
	    "count" : { $sum : 1 }
	}})

//print("\nchunks sent per shard per collection): ")
sent = 
    db.changelog.aggregate(
	{ $match : { "what" : "moveChunk.commit"}},
	{ $group : {
	    _id : { "shard" : "$details.from", "collection" : "$ns" },
	    "chunksSent" : {$sum : 1}
	}})

// save basic summary
db.summary.save(
{
    "shardCount" : numShards,
    "liveCollections" : numLiveCollections,
    "collections" : collections.result,
    "chunksPerCollection" : chunksPerCollection.result,
    "chunksPerShard" : chunksPerShard,
    "chunkSummary" : chunks.result,
    "changeLogBeginTime" : beginTime,
    "changeLogEndTime" : endTime,
    "changeTypeHistogram" : changelog.result,
    "changeLogRangeInDays" : diff,
    "chunksSentPerShardPerCollection" : sent.result
})



chunks = chunks.result
// array of committed migrations in reverse chronological order
recent = db.changelog.find( { "what" : "moveChunk.commit"}).sort({"time":-1})

/* create a "movie" of snapshots illustrating chunk migration activity, failure/success, and end chunk per shard per collection status*/
// topTime is the maximum time of a "movie" snapshot
topTime = endTime

// dayCount is the shapshot count, reverse chonological order
dayCount=1

// bottomTime is the minimum time of a "movie" snapshot
bottomTime = new Date(topTime.getTime()-day)

// We have the first (reverse-chron-order) snapshot based on current state
db.movie.save(
    {
	"endTime" : topTime,
	"beginTime" : bottomTime,
	"daysAgo" : dayCount,
	"chunksAtEnd" : chunks
    })

// should use var for local variables

// loop over committed migrations in reverse order, saving snapshots at every "day"
recent.forEach(function(doc) { 
    xTime = doc.time
    //saveSnapshots
    while (xTime < bottomTime) {
	dayCount+=1
	db.movie.save(
	    {
		"endTime" : topTime,
		"beginTime": bottomTime,
		"daysAgo" : dayCount,
		"chunksAtEnd" : chunks
	    })
	topTime = bottomTime
	bottomTime = new Date(topTime.getTime()-day)
    }
    ns = doc.ns
    from = doc.details.from
    to = doc.details.to
    for (var y=0; y< chunks.length; y++) {
	if (chunks[y]._id.collection == ns ) {
  	    if (chunks[y]._id.shard == from)
		chunks[y].chunkCount-=1
	    if (chunks[y]._id.shard == to)
		chunks[y].chunkCount+=1
	}
    }
})

// save snapshots all the way to the beginning,
// even if there are no committed migrations 
// (useful for next level of detail, i.e. aborted migrations)
while (topTime > beginTime) {
    dayCount+=1
    db.movie.save(
	{
	    "endTime" : topTime,
	    "beginTime": bottomTime,
	    "daysAgo" : dayCount,
	    "chunksAtEnd" : chunks
	})
    topTime = bottomTime
    bottomTime = new Date(topTime.getTime()-day)
}

// reset the loop, now grabbing non-commit details
dayCount = 1
topTime = endTime

while (topTime.getTime() > beginTime.getTime()) {
    // one day less than topTime
    bottomTime = new Date(topTime.getTime()-day)

    // histogram of changes during the day
    changeKinds = 
	db.changelog.aggregate(
	    { $match: {
		"time" : { $gt : bottomTime, $lte : topTime }
	    }},
	    { $group: {
		_id : "$what",
		"count" : { $sum : 1 }
	    }})

    // during this snapshot, look at unique donor shards 
    // that started a migration. Some may have failed
    uniqueDonorStarts = 
	db.changelog.aggregate(
	    { $match: {
		"time" : { $gt : bottomTime, $lte : topTime },
		"what" : "moveChunk.start"
	    }},
	    { $group : {
		_id : "$details.from",
		"count" : { $sum : 1 }
	    }})
    // look at aborts during snapshots
    // moveChunk.from and moveChunk.to overlap
    aborts = 
	db.changelog.aggregate(
	    { $match: {
		"time" : { $gt : bottomTime, $lte : topTime },
		"what" : { $in : ["moveChunk.from","moveChunk.to"]},
		"details.note" : "aborted"
	    }},
	    { $group : {
		_id : "$what",
		"count" : { $sum : 1 }
	    }})

    // how much time was spent on successful migrations? 
    // from moveChunk.from point-of-view
    spentSuccess = 
	     db.changelog.aggregate(
		 { $match : { 
		     "what" : "moveChunk.from" ,
		     "time" : { $gt : bottomTime, $lte : topTime },
		     "details.note" :{ $ne : "aborted" }
		 }},
		 { $group : {
		     _id : "$what",
		     "count" : {$sum : 1 },
		     "step1": {$sum : "$details.step1 of 6"},
		     "step2": {$sum : "$details.step2 of 6"},
		     "step3": {$sum : "$details.step3 of 6"},
		     "step4": {$sum : "$details.step4 of 6"},
		     "step5": {$sum : "$details.step5 of 6"},
		     "step6": {$sum : "$details.step6 of 6"}
		 }},
		 { $project : {
		   _id : 1,
		   "count" : 1,
		   "totalTimeSpent" : { '$add' : ["$step1","$step2","$step3","$step4","$step5","$step6"] }
		 }})

    // how much time was spent on aborted migrations? 
    // from moveChunk.from point-of-view
    spentAborted = 
	     db.changelog.aggregate(
		 { $match : { 
		     "what" : "moveChunk.from" ,
		     "time" : { $gt : bottomTime, $lte : topTime },
		     "details.note" : "aborted" 
		 }},
		 { $group : {
		     _id : "$what",
		     "count" : {$sum : 1 },
		     "step1": {$sum : "$details.step1 of 6"},
		     "step2": {$sum : "$details.step2 of 6"},
		     "step3": {$sum : "$details.step3 of 6"},
		     "step4": {$sum : "$details.step4 of 6"},
		     "step5": {$sum : "$details.step5 of 6"},
		     "step6": {$sum : "$details.step6 of 6"}
		 }},
		 { $project : {
		   _id : 1,
		   "count" : 1,
		   "totalTimeSpent" : { '$add' : ["$step1","$step2","$step3","$step4","$step5","$step6"] }
		 }}
	     )

    //update the movie
    db.movie.update(
	{"daysAgo":dayCount},
	{ $set : {
	    "changeKinds" : changeKinds.result,
	    "uniqueDonorStarts" : uniqueDonorStarts.result,
	    "aborts" : aborts.result,
	    "timeSpentOnSuccess" : spentSuccess.result,
	    "timeSpentOnAborts" : spentAborted.result
	}})
    dayCount++
    topTime = bottomTime
}

// show summary on exit
printjson(db.summary.find().toArray())
