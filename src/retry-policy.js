function retryDelay(attempt) { return [2000,5000,10000,15000][Math.min(3,Math.max(0,attempt))]; }
module.exports={retryDelay};
