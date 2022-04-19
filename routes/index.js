var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Dashboard' });
});
router.get('/graph', function(req, res, next) {
  res.render('nav-menu/empty', { title: 'Dashboard' });
});
router.get('/accordion', function(req, res, next) {
  res.render('nav-menu/accordion', { title: 'Dashboard' });
});

module.exports = router;
