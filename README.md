# Amazon S3 Zipping tool (aws-s3-zipper)

## What do it do?
###1. Zips S3 files
Takes an amazon s3 bucket folder and zips it to a:
* Stream
* Local File
* S3 File (ie uploads the zip back to s3)

###2. Differential zipping
It also allows you to do *differential* zips. Youc an save the key of the last file you zipped and then zip files that have been uploaded after the last zip.

###3. Filter Files to zip
You can filter out files you dont want zipped based on any criteria you need



##How do i use it?
### Setup
```
var S3Zipper = require ('aws-s3-zipper');

var config ={
    accessKeyId: "XXXX",
    secretAccessKey: "XXXX",
    region: "us-west-2",
    bucket: 'XXX'
};
var zipper = new S3Zipper(config);
```

###Filter out Files
```
zipper.filterOutFiles= function(file){
    if(file.Key.indexOf('.tmp') >= 0) // filter out temp files
        return null;
    else 
      return file;
};
```

### Zip to local file
```
zipper.zipToFile ("myBucketFolderName",'keyOfLastFileIZipped', './myLocalFile.zip',function(err,result){
    if(err)
        console.error(err);
    else{
        var lastFile = result.zippedFiles[result.zippedFiles.length-1];
        if(lastFile)
            console.log('last key ', lastFile.Key); // next time start from here
    }
});
```



### Zip to S3 file
```
/// if no path is given to S3 zip file then it will be placed in the same folder
zipper.zipToS3File ("myBucketFolderName",'keyOfLastFileIZipped', 'myS3File.zip',function(err,result){
    if(err)
        console.error(err);
    else{
        var lastFile = result.zippedFiles[result.zippedFiles.length-1];
        if(lastFile)
            console.log('last key ', lastFile.Key); // next time start from here
    }
});
```

##The Details
### `init`
Either from the construcor or from the `init(config)` function you can pass along the AWS config object
```
{
    accessKeyId: [Your access id],
    secretAccessKey: [your access key],
    region: [the region of your S3 bucket],
    bucket: [your bucket name]
}
```

### `filterOutFiles(file)`
Override this function when you want to filter out certain files. The `file` param that is passed to you is the format of the aws file
* file
```
/// as of when this document was written
{
  Key: [file key], // this is what you use to keep track of where you left off
  ETag: [file tag],
  LastModified: [i'm sure you get it],
  Owner: {},
  Size: [in bytes],
  StorageClass: [type of storage]
}
```

### `getFiles: function(folderName,startKey,callback)`
Get a list of files in the bucket folder
* `foldeName` : the name of the folder in the bucket
* `startKey`: optional. return files listed after this file key
* `callback(err,files)`: the function you want called when the list returns
  * `err`: error object if it exists
  * `files`: array of files found

### `streamZipDataTo: function (pipe,folderName, startKey, callback)`
If you want to get a stream to pipe raw data to. For example if you wanted to stream the zip file directly to an http response
* `pipe`: the pipe to which you want the stream to feed
* `folderName`: the name of the bucket folder you want to stream
* `startKey`: optional. start zipping after this file key
* `callback(err,result)`: call this function when done
  * `err`: the error object if any
  * `result`: the resulting archiver zip object with attached property 'manifest' whcih is an array of files it zipped

### `zipToS3File: function (s3FolderName,startKey,s3ZipFileName ,callback)`
Zip files in an s3 folder and place the zip file back on s3
* `s3FolderName`: the name of the bucket folder you want to stream
* `startKey`: optional. start zipping after this file key
* `s3FilerName`: the name of the new s3 zip file including its path. if no path is given it will defult to the same s3 folder
* `callback(err,result)`: call this function when done
  * `err`: the error object if any
  * `result`: the resulting archiver zip object with attached property 'manifest' whcih is an array of files it zipped

### `zipToFile: function (s3FolderName,startKey,zipFileName ,callback)`
Zip files to a local zip file. 
* `s3FolderName`: the name of the bucket folder you want to stream
* `startKey`: optional. start zipping after this file key
* `filerName`: the name of the new local zip file including its path.
* `callback(err,result)`: call this function when done
  * `err`: the error object if any
  * `result`: the resulting archiver zip object with attached property 'manifest' whcih is an array of files it zipped
