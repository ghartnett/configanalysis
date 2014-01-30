configanalysis
==============

MongoDB stores important metadata for a sharded cluster in a database named config. This script does some simple analytics on a saved copy of this database in order to help better understand what's going on in the cluster and facilitate diagnosing problems.

Before running:
       Use mongodrestore to restore a config database that has been sent via mongodump.
       The mongorestore will create a database named config.
       This analysis script will analyze a database named config.
       The script will create a collection named summary with a single document in it.
       The script will create a collection named movie with snapshots of the configuration over time, where each snapshot represents a single day of events from the changelog.
       	   Line 6 defines the snapshot granularity as a day and can be modified.

To execute the script, simply run the script as input to mongo with appropriate connection settings to connect to the mongod where the config dump has been restored. 
For example:
> mongo ConfigDumpAnalysis.js
