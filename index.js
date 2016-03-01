var assert = require('assert');
var Stream = require('stream');
//var archiver = require('archiver');
var AdmZip = require('adm-zip');

var async = require('async');
var AWS = require('aws-sdk');

function S3Zipper(awsConfig) {
    assert.ok(awsConfig, 'AWS S3 options must be defined.');
    assert.notEqual(awsConfig.accessKeyId, undefined, 'Requires S3 AWS Key.');
    assert.notEqual(awsConfig.secretAccessKey, undefined, 'Requres S3 AWS Secret');
    assert.notEqual(awsConfig.region, undefined, 'Requires AWS S3 region.');
    assert.notEqual(awsConfig.bucket, undefined, 'Requires AWS S3 bucket.');
    this.init(awsConfig);
}
S3Zipper.prototype = {
    init: function (awsConfig) {
        this.awsConfig = awsConfig;
        AWS.config.update({
            accessKeyId: awsConfig.accessKeyId,
            secretAccessKey: awsConfig.secretAccessKey,
            region: awsConfig.region
        });
        this.s3bucket = new AWS.S3({
            params: {
                Bucket: this.awsConfig.bucket
            }
        });

    }
    ,filterOutFiles: function(fileObj){
        return fileObj;
    }
    ,getFiles: function(folderName,startKey,callback){

        var bucketParams = {
            Bucket: this.awsConfig.bucket, /* required */
            Delimiter: "/",
            Prefix: folderName + "/"
            //MaxKeys: 50
        };
        if (startKey)
            bucketParams.Marker = startKey;

        var t = this;
        this.s3bucket.listObjects(bucketParams, function (err, data) {
            if (err) {
                callback(err, null);
            } else {
                var result = [];
                for (var i = 0; i < data.Contents.length; i++) {
                    var passedFile = t.filterOutFiles(data.Contents[i]);
                    if(passedFile)
                        result.push(passedFile);
                }
                callback(null, result);
            }
        });
    }
    ,createZipObject: function (folderName,startKey, callback) {
        if (!folderName) {
            console.error('folderName required');
            return null;
        }

        if(typeof(startKey) == "function" && !callback ) {
            callback = startKey;
            startKey=null;
        }

        //var archive = archiver('zip');
        var zip = new AdmZip();

        var t= this;

        this.getFiles(folderName,startKey,function(err,files){
            if(err)
                console.error(err);
            else{
                async.map(files,function(f,callback){
                    t.s3bucket.getObject({Bucket: t.awsConfig.bucket,Key: f.Key },function(err,data){
                        if(err)
                            callback(err);
                        else {
                            var name = f.Key.split("/");
                            name.shift();
                            name = name.join("/");
                            console.log('zipping ', name,'...');
                            zip.addFile(name ,new Buffer(data.Body));
                            callback(null, f);
                        }

                    });

                }, function(err,results){
                    zip.manifest = results;
                    callback(err,zip);
                });
            }
        });

    }
    ,zipToS3File: function (folderName,startKey,s3ZipFileName ,callback){
        var t= this;

        if(s3ZipFileName.indexOf("/") < 0)
            s3ZipFileName = folderName + "/" + s3ZipFileName;

        this.createZipObject(folderName,startKey,function(err,zip){
            console.log('uploading ',s3ZipFileName,'...');
            t.s3bucket.putObject({Bucket: t.awsConfig.Bucket,Key :s3ZipFileName, Body :zip.toBuffer()},function(err,result){
                if(err)
                    callback(err);
                else {
                    console.log('zip upload completed.');
                    return {
                        zipFileETag: result.ETag,
                        zippedFiles: zip.manifest
                    };
                }
            } );
        })
    }
};

module.exports = S3Zipper;
