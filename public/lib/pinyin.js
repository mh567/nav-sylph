/**
 * 轻量级拼音转换工具
 * 支持将中文转换为拼音首字母和全拼
 */
(function(global) {
    'use strict';

    // 拼音映射表（按Unicode编码范围分组）
    // 格式: 起始码点, 拼音数组
    const PINYIN_DICT = {
        // 常用汉字拼音映射（约6000字）
        // 这里使用压缩格式：每个汉字对应一个拼音
    };

    // 使用更高效的方式：直接存储常用字的拼音
    const CHAR_PINYIN = 'a]ai]an]ang]ao]ba]bai]ban]bang]bao]bei]ben]beng]bi]bian]biao]bie]bin]bing]bo]bu]ca]cai]can]cang]cao]ce]cen]ceng]cha]chai]chan]chang]chao]che]chen]cheng]chi]chong]chou]chu]chua]chuai]chuan]chuang]chui]chun]chuo]ci]cong]cou]cu]cuan]cui]cun]cuo]da]dai]dan]dang]dao]de]dei]den]deng]di]dia]dian]diao]die]ding]diu]dong]dou]du]duan]dui]dun]duo]e]ei]en]eng]er]fa]fan]fang]fei]fen]feng]fo]fou]fu]ga]gai]gan]gang]gao]ge]gei]gen]geng]gong]gou]gu]gua]guai]guan]guang]gui]gun]guo]ha]hai]han]hang]hao]he]hei]hen]heng]hong]hou]hu]hua]huai]huan]huang]hui]hun]huo]ji]jia]jian]jiang]jiao]jie]jin]jing]jiong]jiu]ju]juan]jue]jun]ka]kai]kan]kang]kao]ke]ken]keng]kong]kou]ku]kua]kuai]kuan]kuang]kui]kun]kuo]la]lai]lan]lang]lao]le]lei]leng]li]lia]lian]liang]liao]lie]lin]ling]liu]lo]long]lou]lu]luan]lun]luo]lv]ma]mai]man]mang]mao]me]mei]men]meng]mi]mian]miao]mie]min]ming]miu]mo]mou]mu]na]nai]nan]nang]nao]ne]nei]nen]neng]ni]nian]niang]niao]nie]nin]ning]niu]nong]nou]nu]nuan]nun]nuo]nv]o]ou]pa]pai]pan]pang]pao]pei]pen]peng]pi]pian]piao]pie]pin]ping]po]pou]pu]qi]qia]qian]qiang]qiao]qie]qin]qing]qiong]qiu]qu]quan]que]qun]ran]rang]rao]re]ren]reng]ri]rong]rou]ru]ruan]rui]run]ruo]sa]sai]san]sang]sao]se]sen]seng]sha]shai]shan]shang]shao]she]shei]shen]sheng]shi]shou]shu]shua]shuai]shuan]shuang]shui]shun]shuo]si]song]sou]su]suan]sui]sun]suo]ta]tai]tan]tang]tao]te]teng]ti]tian]tiao]tie]ting]tong]tou]tu]tuan]tui]tun]tuo]wa]wai]wan]wang]wei]wen]weng]wo]wu]xi]xia]xian]xiang]xiao]xie]xin]xing]xiong]xiu]xu]xuan]xue]xun]ya]yan]yang]yao]ye]yi]yin]ying]yo]yong]you]yu]yuan]yue]yun]za]zai]zan]zang]zao]ze]zei]zen]zeng]zha]zhai]zhan]zhang]zhao]zhe]zhei]zhen]zheng]zhi]zhong]zhou]zhu]zhua]zhuai]zhuan]zhuang]zhui]zhun]zhuo]zi]zong]zou]zu]zuan]zui]zun]zuo'.split(']');

    // Unicode 汉字拼音索引（压缩存储）
    // 每个汉字对应 CHAR_PINYIN 数组中的索引
    const PINYIN_INDEX = '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

    // 常用汉字拼音直接映射（更高效）
    const COMMON_PINYIN = {};

    // 初始化常用汉字映射（约3000常用字）
    const initCommonPinyin = () => {
        // 分批初始化以提高可读性
        const data = [
            // 最常用500字
            '的de,一yi,是shi,不bu,了le,在zai,人ren,有you,我wo,他ta,这zhe,个ge,们men,中zhong,来lai,上shang,大da,为wei,和he,国guo',
            '地di,到dao,以yi,说shuo,时shi,要yao,就jiu,出chu,会hui,可ke,也ye,你ni,对dui,生sheng,能neng,而er,子zi,那na,得de,于yu',
            '着zhe,下xia,自zi,之zhi,年nian,过guo,发fa,后hou,作zuo,里li,如ru,进jin,着zhuo,等deng,新xin,想xiang,已yi,从cong,两liang,些xie',
            '还hai,天tian,面mian,又you,长chang,被bei,老lao,因yin,很hen,给gei,名ming,法fa,成cheng,部bu,度du,家jia,电dian,力li,理li,起qi',
            '小xiao,物wu,现xian,实shi,加jia,量liang,都dou,点dian,月yue,业ye,义yi,门men,与yu,间jian,相xiang,科ke,五wu,机ji,九jiu,压ya',
            '问wen,总zong,条tiao,山shan,者zhe,司si,看kan,只zhi,用yong,主zhu,行xing,前qian,所suo,然ran,学xue,样yang,本ben,经jing,动dong,同tong',
            '工gong,无wu,开kai,但dan,因yin,此ci,当dang,没mei,全quan,好hao,三san,种zhong,最zui,高gao,多duo,分fen,其qi,外wai,水shui,化hua',
            '公gong,正zheng,或huo,定ding,明ming,日ri,第di,将jiang,军jun,二er,几ji,次ci,内nei,去qu,被bei,她ta,产chan,厂chang,什shen,合he',
            '把ba,性xing,手shou,应ying,向xiang,道dao,头tou,给gei,使shi,文wen,车che,于yu,身shen,打da,情qing,特te,变bian,反fan,处chu,数shu',
            '提ti,世shi,真zhen,式shi,系xi,意yi,表biao,解jie,任ren,走zou,常chang,先xian,海hai,通tong,入ru,教jiao,民min,员yuan,口kou,指zhi',
            // 常用字续
            '期qi,必bi,区qu,东dong,论lun,活huo,回hui,则ze,知zhi,战zhan,原yuan,位wei,百bai,报bao,立li,少shao,路lu,心xin,界jie,今jin',
            '白bai,求qiu,目mu,太tai,元yuan,社she,决jue,交jiao,受shou,联lian,风feng,步bu,建jian,即ji,接jie,信xin,觉jue,美mei,军jun,候hou',
            '务wu,利li,服fu,象xiang,选xuan,设she,治zhi,北bei,朝chao,死si,让rang,党dang,西xi,离li,况kuang,广guang,达da,深shen,济ji,农nong',
            '村cun,构gou,专zhuan,做zuo,运yun,光guang,制zhi,住zhu,满man,确que,呢ne,听ting,该gai,铁tie,价jia,严yan,首shou,底di,统tong,导dao',
            '消xiao,南nan,组zu,改gai,历li,转zhuan,画hua,造zao,局ju,强qiang,测ce,传chuan,花hua,金jin,析xi,红hong,识shi,参can,千qian,增zeng',
            '色se,杀sha,六liu,规gui,思si,展zhan,线xian,更geng,管guan,写xie,青qing,办ban,城cheng,取qu,落luo,格ge,基ji,照zhao,片pian,放fang',
            '结jie,响xiang,持chi,态tai,护hu,调diao,断duan,算suan,远yuan,另ling,投tou,准zhun,单dan,毛mao,团tuan,集ji,需xu,存cun,英ying,味wei',
            '带dai,网wang,继ji,包bao,形xing,影ying,句ju,查cha,须xu,离li,却que,质zhi,病bing,近jin,排pai,每mei,音yin,医yi,火huo,布bu',
            '易yi,据ju,费fei,破po,记ji,言yan,争zheng,令ling,器qi,完wan,各ge,约yue,支zhi,流liu,极ji,育yu,示shi,复fu,息xi,苦ku',
            '油you,族zu,神shen,究jiu,章zhang,鱼yu,河he,八ba,注zhu,足zu,速su,防fang,拉la,例li,草cao,越yue,清qing,久jiu,停ting,非fei',
            // 技术/网络相关
            '网wang,站zhan,页ye,码ma,端duan,程cheng,序xu,软ruan,件jian,硬ying,盘pan,存cun,储chu,器qi,库ku,据ju,框kuang,架jia,接jie,口kou',
            '协xie,议yi,服fu,务wu,客ke,户hu,浏liu,览lan,搜sou,索suo,引yin,擎qing,链lian,登deng,录lu,注zhu,册ce,账zhang,号hao,密mi',
            '钥yao,加jia,密mi,解jie,压ya,缩suo,包bao,装zhuang,载zai,传chuan,输shu,配pei,置zhi,参can,数shu,变bian,量liang,函han,数shu,类lei',
            '型xing,组zu,数shu,列lie,字zi,符fu,串chuan,整zheng,浮fu,布bu,尔er,真zhen,假jia,空kong,值zhi,返fan,回hui,调diao,试shi,错cuo',
            '误wu,警jing,告gao,提ti,示shi,消xiao,息xi,通tong,知zhi,推tui,送song,订ding,阅yue,取qu,消xiao,确que,认ren,保bao,存cun,删shan',
            '除chu,修xiu,改gai,编bian,辑ji,复fu,制zhi,粘zhan,贴tie,剪jian,切qie,撤che,销xiao,恢hui,复fu,刷shua,新xin,缓huan,冲chong,清qing',
            // 工具/应用相关
            '工gong,具ju,应ying,用yong,插cha,件jian,扩kuo,展zhan,模mo,板ban,主zhu,题ti,样yang,式shi,布bu,局ju,排pai,版ban,字zi,体ti',
            '颜yan,色se,背bei,景jing,边bian,框kuang,圆yuan,角jiao,阴yin,影ying,透tou,明ming,渐jian,变bian,动dong,画hua,效xiao,果guo,滚gun,动dong',
            '滑hua,点dian,击ji,双shuang,触chu,摸mo,拖tuo,拽zhuai,放fang,缩suo,旋xuan,转zhuan,翻fan,页ye,切qie,换huan,跳tiao,转zhuan,返fan,回hui',
            '首shou,页ye,末mo,尾wei,顶ding,部bu,底di,左zuo,右you,居ju,中zhong,对dui,齐qi,分fen,散san,均jun,等deng,间jian,距ju,填tian',
            // 分类/标签相关
            '分fen,类lei,标biao,签qian,文wen,件jian,夹jia,目mu,录lu,路lu,径jing,根gen,父fu,子zi,兄xiong,弟di,节jie,点dian,叶ye,树shu',
            '图tu,表biao,列lie,网wang,格ge,卡ka,片pian,瀑pu,布bu,流liu,时shi,间jian,轴zhou,日ri,历li,周zhou,月yue,年nian,季ji,度du',
            // 收藏/书签相关
            '收shou,藏cang,书shu,签qian,喜xi,欢huan,关guan,注zhu,订ding,阅yue,历li,史shi,最zui,近jin,常chang,用yong,热re,门men,推tui,荐jian',
            '新xin,闻wen,资zi,讯xun,博bo,客ke,论lun,坛tan,社she,区qu,问wen,答da,百bai,科ke,词ci,典dian,翻fan,译yi,地di,图tu',
            '导dao,航hang,天tian,气qi,日ri,历li,计ji,算suan,器qi,笔bi,记ji,便bian,签qian,提ti,醒xing,闹nao,钟zhong,秒miao,表biao,倒dao,计ji',
            // 娱乐/媒体相关
            '视shi,频pin,音yin,乐le,电dian,影ying,剧ju,综zong,艺yi,动dong,漫man,游you,戏xi,直zhi,播bo,短duan,拍pai,照zhao,相xiang,册ce',
            '壁bi,纸zhi,头tou,像xiang,表biao,情qing,贴tie,图tu,弹dan,幕mu,评ping,论lun,点dian,赞zan,转zhuan,发fa,分fen,享xiang,私si,信xin',
            // 购物/生活相关
            '购gou,物wu,商shang,城cheng,店dian,铺pu,商shang,品pin,价jia,格ge,优you,惠hui,券quan,折zhe,扣kou,满man,减jian,包bao,邮you,运yun',
            '费fei,快kuai,递di,物wu,流liu,订ding,单dan,支zhi,付fu,钱qian,包bao,银yin,行hang,卡ka,信xin,用yong,花hua,呗bei,借jie,贷dai',
            // 办公/学习相关
            '办ban,公gong,文wen,档dang,表biao,格ge,演yan,示shi,幻huan,灯deng,片pian,思si,维wei,导dao,图tu,流liu,程cheng,甘gan,特te,看kan',
            '板ban,协xie,作zuo,共gong,享xiang,云yun,盘pan,同tong,步bu,备bei,份fen,恢hui,复fu,版ban,本ben,控kong,制zhi,合he,并bing,冲chong',
            '突tu,分fen,支zhi,主zhu,干gan,标biao,记ji,里li,程cheng,碑bei,任ren,务wu,清qing,单dan,待dai,办ban,已yi,完wan,成cheng,进jin,度du',
            // 更多常用字
            '爱ai,安an,案an,暗an,按an,岸an,奥ao,澳ao,吧ba,拔ba,霸ba,败bai,班ban,般ban,搬ban,半ban,办ban,帮bang,棒bang,宝bao',
            '抱bao,暴bao,爆bao,杯bei,背bei,倍bei,奔ben,笨ben,崩beng,逼bi,鼻bi,比bi,彼bi,笔bi,币bi,闭bi,避bi,壁bi,臂bi,边bian',
            '便bian,遍bian,辩bian,标biao,彪biao,膘biao,别bie,宾bin,冰bing,兵bing,饼bing,柄bing,波bo,玻bo,剥bo,播bo,伯bo,泊bo,勃bo,博bo',
            '补bu,捕bu,不bu,步bu,怖bu,擦ca,猜cai,才cai,材cai,财cai,采cai,彩cai,菜cai,蔡cai,餐can,残can,惨can,灿can,仓cang,苍cang',
            '藏cang,操cao,槽cao,曹cao,册ce,侧ce,策ce,层ceng,曾ceng,叉cha,插cha,茶cha,察cha,差cha,拆chai,柴chai,缠chan,产chan,颤chan,昌chang',
            '场chang,尝chang,偿chang,肠chang,敞chang,畅chang,唱chang,抄chao,超chao,巢chao,吵chao,炒chao,扯che,彻che,尘chen,沉chen,陈chen,衬chen,称cheng,撑cheng',
            '城cheng,乘cheng,程cheng,惩cheng,诚cheng,承cheng,呈cheng,澄cheng,橙cheng,吃chi,池chi,迟chi,持chi,尺chi,齿chi,耻chi,斥chi,赤chi,翅chi,充chong',
            '虫chong,崇chong,宠chong,抽chou,仇chou,绸chou,愁chou,筹chou,丑chou,臭chou,初chu,除chu,厨chu,础chu,储chu,楚chu,触chu,川chuan,穿chuan,船chuan',
            '喘chuan,窗chuang,床chuang,创chuang,闯chuang,吹chui,垂chui,锤chui,春chun,纯chun,唇chun,蠢chun,词ci,瓷ci,辞ci,慈ci,磁ci,雌ci,刺ci,赐ci',
            '聪cong,丛cong,凑cou,粗cu,促cu,醋cu,窜cuan,催cui,脆cui,翠cui,村cun,寸cun,措cuo,挫cuo,搭da,达da,答da,打da,呆dai,代dai',
            '袋dai,戴dai,担dan,丹dan,胆dan,淡dan,蛋dan,弹dan,挡dang,党dang,荡dang,刀dao,倒dao,岛dao,蹈dao,盗dao,德de,灯deng,登deng,凳deng',
            '敌di,滴di,迪di,底di,抵di,递di,帝di,弟di,缔di,颠dian,典dian,店dian,垫dian,殿dian,雕diao,吊diao,钓diao,掉diao,跌die,叠die',
            '蝶die,丁ding,盯ding,钉ding,顶ding,鼎ding,订ding,丢diu,冬dong,董dong,懂dong,洞dong,冻dong,抖dou,斗dou,豆dou,逗dou,督du,毒du,独du',
            '读du,堵du,赌du,杜du,肚du,镀du,渡du,端duan,段duan,锻duan,堆dui,队dui,兑dui,吨dun,蹲dun,盾dun,顿dun,夺duo,朵duo,躲duo',
            '俄e,额e,恶e,饿e,鹅e,蛾e,峨e,娥e,鳄e,恩en,儿er,耳er,尔er,饵er,贰er,罚fa,阀fa,法fa,帆fan,番fan',
            '翻fan,凡fan,烦fan,繁fan,反fan,返fan,犯fan,泛fan,饭fan,范fan,贩fan,方fang,坊fang,芳fang,房fang,仿fang,访fang,纺fang,肥fei,废fei',
            '沸fei,肺fei,匪fei,吠fei,坟fen,粉fen,奋fen,愤fen,丰feng,封feng,枫feng,疯feng,峰feng,锋feng,蜂feng,冯feng,逢feng,缝feng,凤feng,奉feng',
            '佛fo,否fou,夫fu,肤fu,伏fu,扶fu,服fu,浮fu,符fu,幅fu,福fu,抚fu,府fu,辅fu,腐fu,父fu,付fu,妇fu,附fu,负fu',
            // G-H
            '复fu,富fu,腹fu,覆fu,该gai,盖gai,概gai,干gan,甘gan,杆gan,肝gan,赶gan,敢gan,感gan,刚gang,钢gang,港gang,岗gang,杠gang,高gao',
            '搞gao,稿gao,告gao,哥ge,歌ge,革ge,隔ge,阁ge,割ge,葛ge,根gen,跟gen,更geng,耕geng,工gong,攻gong,功gong,供gong,宫gong,恭gong',
            '巩gong,贡gong,共gong,勾gou,沟gou,钩gou,狗gou,构gou,购gou,够gou,估gu,姑gu,孤gu,辜gu,古gu,谷gu,股gu,骨gu,鼓gu,固gu',
            '故gu,顾gu,雇gu,瓜gua,刮gua,挂gua,乖guai,怪guai,关guan,观guan,官guan,冠guan,馆guan,管guan,贯guan,惯guan,灌guan,罐guan,光guang,逛guang',
            '归gui,龟gui,规gui,轨gui,鬼gui,贵gui,桂gui,柜gui,跪gui,滚gun,棍gun,锅guo,国guo,果guo,裹guo,过guo,哈ha,孩hai,海hai,害hai',
            '含han,寒han,函han,韩han,罕han,喊han,汉han,汗han,旱han,杭hang,航hang,毫hao,豪hao,好hao,号hao,耗hao,浩hao,呵he,喝he,禾he',
            '合he,何he,河he,核he,荷he,盒he,贺he,褐he,赫he,鹤he,黑hei,痕hen,恨hen,哼heng,恒heng,横heng,衡heng,轰hong,哄hong,烘hong',
            '虹hong,鸿hong,洪hong,宏hong,红hong,喉hou,猴hou,吼hou,后hou,厚hou,候hou,乎hu,呼hu,忽hu,狐hu,胡hu,壶hu,湖hu,葫hu,糊hu',
            '蝴hu,虎hu,互hu,户hu,护hu,花hua,华hua,哗hua,滑hua,划hua,化hua,话hua,怀huai,淮huai,坏huai,欢huan,环huan,还huan,缓huan,幻huan',
            '换huan,唤huan,患huan,荒huang,慌huang,皇huang,黄huang,煌huang,晃huang,恍huang,谎huang,灰hui,挥hui,辉hui,恢hui,回hui,悔hui,汇hui,会hui,绘hui',
            '惠hui,毁hui,贿hui,秽hui,昏hun,婚hun,魂hun,浑hun,混hun,豁huo,活huo,火huo,伙huo,或huo,货huo,获huo,祸huo,惑huo,霍huo,击ji',
            // J-K
            '饥ji,圾ji,机ji,肌ji,鸡ji,积ji,基ji,迹ji,激ji,及ji,吉ji,级ji,即ji,极ji,急ji,疾ji,集ji,籍ji,几ji,己ji',
            '挤ji,脊ji,计ji,记ji,纪ji,忌ji,技ji,际ji,剂ji,季ji,寂ji,继ji,寄ji,加jia,佳jia,家jia,嘉jia,夹jia,颊jia,甲jia',
            '贾jia,钾jia,假jia,价jia,驾jia,嫁jia,架jia,尖jian,坚jian,歼jian,间jian,肩jian,艰jian,兼jian,监jian,煎jian,拣jian,俭jian,剪jian,减jian',
            '荐jian,槛jian,鉴jian,践jian,箭jian,件jian,健jian,舰jian,渐jian,溅jian,涧jian,建jian,僵jiang,姜jiang,将jiang,浆jiang,江jiang,疆jiang,讲jiang,奖jiang',
            '桨jiang,匠jiang,降jiang,酱jiang,交jiao,郊jiao,浇jiao,娇jiao,骄jiao,胶jiao,焦jiao,蕉jiao,角jiao,狡jiao,饺jiao,脚jiao,搅jiao,缴jiao,绞jiao,轿jiao',
            '较jiao,叫jiao,窖jiao,揭jie,接jie,皆jie,街jie,阶jie,截jie,劫jie,节jie,杰jie,洁jie,结jie,捷jie,姐jie,解jie,戒jie,届jie,界jie',
            '借jie,介jie,疥jie,巾jin,斤jin,金jin,津jin,筋jin,仅jin,紧jin,锦jin,尽jin,劲jin,近jin,进jin,晋jin,浸jin,禁jin,京jing,经jing',
            '茎jing,惊jing,晶jing,睛jing,精jing,鲸jing,井jing,颈jing,景jing,警jing,净jing,径jing,竞jing,竟jing,敬jing,境jing,静jing,镜jing,纠jiu,究jiu',
            '揪jiu,九jiu,久jiu,酒jiu,旧jiu,救jiu,就jiu,舅jiu,居ju,拘ju,狙ju,驹ju,菊ju,局ju,矩ju,举ju,巨ju,具ju,俱ju,剧ju',
            '惧ju,据ju,距ju,锯ju,聚ju,捐juan,卷juan,倦juan,绢juan,决jue,绝jue,觉jue,掘jue,嚼jue,军jun,均jun,君jun,菌jun,俊jun,峻jun',
            '卡ka,开kai,凯kai,慨kai,刊kan,堪kan,勘kan,坎kan,砍kan,看kan,康kang,慷kang,抗kang,炕kang,考kao,烤kao,靠kao,科ke,棵ke,颗ke',
            '壳ke,咳ke,可ke,渴ke,克ke,刻ke,客ke,课ke,肯ken,啃ken,坑keng,空kong,孔kong,恐kong,控kong,口kou,扣kou,枯ku,哭ku,窟ku',
            // L-M
            '苦ku,库ku,裤ku,酷ku,夸kua,垮kua,挎kua,跨kua,块kuai,快kuai,宽kuan,款kuan,狂kuang,框kuang,矿kuang,况kuang,亏kui,葵kui,魁kui,馈kui',
            '困kun,捆kun,扩kuo,括kuo,阔kuo,垃la,拉la,啦la,喇la,腊la,蜡la,辣la,来lai,赖lai,兰lan,拦lan,栏lan,蓝lan,篮lan,览lan',
            '懒lan,烂lan,滥lan,郎lang,狼lang,廊lang,朗lang,浪lang,捞lao,劳lao,牢lao,老lao,姥lao,涝lao,乐le,雷lei,蕾lei,泪lei,类lei,累lei',
            '冷leng,愣leng,梨li,离li,璃li,黎li,篱li,狸li,梁liang,粮liang,良liang,凉liang,两liang,辆liang,亮liang,谅liang,量liang,疗liao,聊liao,僚liao',
            '撩liao,燎liao,了liao,料liao,列lie,劣lie,烈lie,猎lie,裂lie,邻lin,林lin,临lin,淋lin,伶ling,灵ling,岭ling,铃ling,陵ling,凌ling,零ling',
            '龄ling,领ling,令ling,溜liu,刘liu,流liu,留liu,硫liu,瘤liu,柳liu,六liu,龙long,笼long,聋long,隆long,垄long,拢long,楼lou,漏lou,露lu',
            '卢lu,芦lu,炉lu,虏lu,鲁lu,陆lu,录lu,鹿lu,碌lu,路lu,驴lv,旅lv,铝lv,屡lv,律lv,率lv,绿lv,滤lv,乱luan,掠lue',
            '略lue,轮lun,伦lun,论lun,罗luo,萝luo,螺luo,裸luo,洛luo,络luo,骆luo,落luo,妈ma,麻ma,马ma,码ma,蚂ma,骂ma,埋mai,买mai',
            '迈mai,卖mai,麦mai,脉mai,蛮man,馒man,瞒man,满man,漫man,蔓man,忙mang,盲mang,茫mang,猫mao,毛mao,矛mao,茅mao,锚mao,冒mao,贸mao',
            '帽mao,貌mao,么me,没mei,眉mei,梅mei,媒mei,煤mei,霉mei,每mei,美mei,妹mei,魅mei,门men,闷men,萌meng,蒙meng,猛meng,孟meng,梦meng',
            // N-P
            '弥mi,迷mi,谜mi,米mi,秘mi,密mi,蜜mi,眠mian,绵mian,棉mian,免mian,勉mian,面mian,苗miao,描miao,秒miao,妙miao,庙miao,灭mie,蔑mie',
            '民min,敏min,名ming,明ming,鸣ming,命ming,摸mo,模mo,膜mo,磨mo,摩mo,魔mo,抹mo,末mo,沫mo,莫mo,墨mo,默mo,谋mou,某mou',
            '母mu,墓mu,幕mu,木mu,目mu,牧mu,穆mu,拿na,哪na,纳na,乃nai,奶nai,耐nai,男nan,难nan,囊nang,恼nao,脑nao,闹nao,呢ne',
            '内nei,嫩nen,能neng,尼ni,泥ni,你ni,逆ni,溺ni,年nian,念nian,娘niang,酿niang,鸟niao,尿niao,捏nie,您nin,宁ning,凝ning,牛niu,扭niu',
            '纽niu,农nong,浓nong,弄nong,奴nu,努nu,怒nu,女nv,暖nuan,挪nuo,诺nuo,欧ou,偶ou,趴pa,爬pa,怕pa,拍pai,排pai,牌pai,派pai',
            '攀pan,盘pan,判pan,叛pan,盼pan,庞pang,旁pang,胖pang,抛pao,跑pao,泡pao,炮pao,陪pei,培pei,赔pei,佩pei,配pei,喷pen,盆pen,朋peng',
            '棚peng,蓬peng,膨peng,捧peng,碰peng,批pi,披pi,劈pi,皮pi,疲pi,脾pi,匹pi,屁pi,譬pi,篇pian,偏pian,片pian,骗pian,漂piao,飘piao',
            '票piao,撇pie,拼pin,贫pin,频pin,品pin,聘pin,平ping,凭ping,瓶ping,评ping,坡po,泼po,颇po,婆po,迫po,破po,魄po,剖pou,扑pu',
            '铺pu,仆pu,朴pu,葡pu,菩pu,普pu,浦pu,谱pu,七qi,妻qi,栖qi,戚qi,期qi,欺qi,漆qi,齐qi,奇qi,歧qi,祈qi,骑qi',
            // Q-R
            '棋qi,旗qi,企qi,启qi,岂qi,起qi,气qi,弃qi,汽qi,契qi,砌qi,器qi,恰qia,洽qia,千qian,迁qian,牵qian,铅qian,谦qian,签qian',
            '前qian,钱qian,潜qian,浅qian,遣qian,欠qian,歉qian,枪qiang,腔qiang,强qiang,墙qiang,抢qiang,悄qiao,敲qiao,乔qiao,桥qiao,瞧qiao,巧qiao,切qie,茄qie',
            '且qie,窃qie,侵qin,亲qin,琴qin,勤qin,青qing,轻qing,氢qing,倾qing,清qing,情qing,晴qing,请qing,庆qing,穷qiong,丘qiu,秋qiu,求qiu,球qiu',
            '区qu,曲qu,驱qu,屈qu,趋qu,渠qu,取qu,娶qu,去qu,趣qu,圈quan,权quan,全quan,泉quan,拳quan,犬quan,劝quan,券quan,缺que,却que',
            '雀que,确que,鹊que,裙qun,群qun,然ran,燃ran,染ran,嚷rang,让rang,饶rao,扰rao,绕rao,惹re,热re,人ren,仁ren,忍ren,认ren,任ren',
            '扔reng,仍reng,日ri,绒rong,荣rong,容rong,溶rong,熔rong,融rong,柔rou,肉rou,如ru,儒ru,乳ru,辱ru,入ru,软ruan,锐rui,瑞rui,润run',
            // S
            '若ruo,弱ruo,撒sa,洒sa,塞sai,赛sai,三san,伞san,散san,桑sang,丧sang,嗓sang,扫sao,嫂sao,骚sao,色se,森sen,杀sha,沙sha,纱sha',
            '傻sha,啥sha,厦sha,筛shai,晒shai,山shan,删shan,杉shan,闪shan,陕shan,扇shan,善shan,伤shang,商shang,赏shang,上shang,尚shang,梢shao,烧shao,稍shao',
            '勺shao,少shao,绍shao,哨shao,舌she,蛇she,舍she,设she,社she,射she,涉she,摄she,申shen,伸shen,身shen,深shen,神shen,沈shen,审shen,婶shen',
            '肾shen,甚shen,渗shen,慎shen,升sheng,生sheng,声sheng,牲sheng,胜sheng,盛sheng,剩sheng,圣sheng,师shi,诗shi,施shi,狮shi,湿shi,十shi,什shi,石shi',
            '时shi,识shi,实shi,拾shi,食shi,史shi,使shi,始shi,驶shi,士shi,氏shi,世shi,市shi,示shi,事shi,侍shi,势shi,视shi,试shi,饰shi',
            '室shi,逝shi,释shi,誓shi,收shou,手shou,守shou,首shou,寿shou,受shou,授shou,售shou,瘦shou,兽shou,蔬shu,书shu,叔shu,殊shu,梳shu,舒shu',
            // T
            '疏shu,输shu,蔬shu,熟shu,暑shu,署shu,鼠shu,属shu,术shu,束shu,述shu,树shu,竖shu,数shu,刷shua,耍shua,摔shuai,甩shuai,帅shuai,栓shuan',
            '双shuang,霜shuang,爽shuang,谁shui,水shui,税shui,睡shui,顺shun,瞬shun,说shuo,硕shuo,司si,丝si,私si,思si,斯si,撕si,死si,四si,寺si',
            '似si,饲si,松song,耸song,宋song,送song,颂song,搜sou,艘sou,苏su,俗su,诉su,肃su,素su,速su,宿su,塑su,酸suan,蒜suan,算suan',
            '虽sui,随sui,岁sui,碎sui,穗sui,遂sui,隧sui,孙sun,损sun,笋sun,缩suo,锁suo,所suo,索suo,他ta,她ta,它ta,塌ta,塔ta,踏ta',
            '台tai,抬tai,太tai,态tai,泰tai,贪tan,摊tan,滩tan,坛tan,谈tan,潭tan,坦tan,叹tan,探tan,炭tan,汤tang,唐tang,堂tang,塘tang,糖tang',
            '躺tang,趟tang,涛tao,逃tao,桃tao,陶tao,淘tao,讨tao,套tao,特te,疼teng,腾teng,梯ti,踢ti,提ti,题ti,蹄ti,体ti,替ti,天tian',
            '田tian,甜tian,填tian,挑tiao,条tiao,跳tiao,贴tie,铁tie,厅ting,听ting,廷ting,亭ting,停ting,挺ting,艇ting,通tong,同tong,铜tong,童tong,桶tong',
            '统tong,痛tong,偷tou,头tou,投tou,透tou,突tu,图tu,徒tu,途tu,涂tu,土tu,吐tu,兔tu,团tuan,推tui,腿tui,退tui,吞tun,托tuo',
            '拖tuo,脱tuo,驼tuo,妥tuo,拓tuo,挖wa,哇wa,蛙wa,瓦wa,袜wa,歪wai,外wai,弯wan,湾wan,丸wan,完wan,玩wan,顽wan,挽wan,晚wan',
            // W
            '碗wan,万wan,汪wang,亡wang,王wang,网wang,往wang,忘wang,旺wang,望wang,危wei,威wei,微wei,为wei,围wei,违wei,唯wei,维wei,伟wei,伪wei',
            '尾wei,委wei,卫wei,未wei,位wei,味wei,畏wei,胃wei,喂wei,慰wei,温wen,文wen,闻wen,纹wen,吻wen,稳wen,问wen,翁weng,窝wo,我wo',
            '沃wo,卧wo,握wo,乌wu,污wu,屋wu,无wu,吴wu,五wu,午wu,伍wu,武wu,舞wu,侮wu,务wu,物wu,误wu,悟wu,雾wu,夕xi',
            // X
            '吸xi,希xi,析xi,息xi,牺xi,悉xi,惜xi,稀xi,溪xi,锡xi,熄xi,膝xi,习xi,席xi,袭xi,媳xi,喜xi,洗xi,系xi,戏xi',
            '细xi,隙xi,虾xia,瞎xia,峡xia,狭xia,霞xia,下xia,吓xia,夏xia,仙xian,先xian,纤xian,掀xian,鲜xian,闲xian,弦xian,贤xian,咸xian,嫌xian',
            '显xian,险xian,县xian,现xian,线xian,限xian,宪xian,陷xian,馅xian,献xian,乡xiang,相xiang,香xiang,箱xiang,湘xiang,详xiang,祥xiang,翔xiang,享xiang,响xiang',
            '想xiang,向xiang,巷xiang,项xiang,象xiang,像xiang,橡xiang,削xiao,消xiao,宵xiao,销xiao,萧xiao,小xiao,晓xiao,孝xiao,效xiao,校xiao,笑xiao,些xie,歇xie',
            '协xie,挟xie,斜xie,携xie,鞋xie,写xie,泄xie,泻xie,卸xie,屑xie,谢xie,蟹xie,心xin,辛xin,欣xin,新xin,信xin,兴xing,星xing,腥xing',
            '刑xing,形xing,型xing,醒xing,杏xing,姓xing,幸xing,性xing,凶xiong,兄xiong,胸xiong,雄xiong,熊xiong,休xiu,修xiu,羞xiu,朽xiu,秀xiu,绣xiu,袖xiu',
            '嗅xiu,须xu,虚xu,需xu,徐xu,许xu,序xu,叙xu,绪xu,续xu,蓄xu,宣xuan,悬xuan,旋xuan,玄xuan,选xuan,癣xuan,眩xuan,绚xuan,靴xue',
            '学xue,雪xue,血xue,勋xun,熏xun,循xun,旬xun,询xun,寻xun,驯xun,巡xun,殉xun,训xun,讯xun,迅xun,逊xun,压ya,呀ya,鸦ya,鸭ya',
            // Y
            '牙ya,芽ya,崖ya,哑ya,雅ya,亚ya,咽yan,烟yan,淹yan,延yan,严yan,言yan,岩yan,沿yan,炎yan,研yan,盐yan,颜yan,阎yan,蜒yan',
            '眼yan,演yan,厌yan,宴yan,艳yan,验yan,焰yan,雁yan,燕yan,央yang,扬yang,羊yang,阳yang,杨yang,洋yang,仰yang,养yang,样yang,氧yang,腰yao',
            '邀yao,摇yao,遥yao,咬yao,药yao,要yao,耀yao,爷ye,也ye,野ye,业ye,叶ye,页ye,夜ye,液ye,一yi,伊yi,衣yi,医yi,依yi',
            '仪yi,宜yi,姨yi,移yi,遗yi,疑yi,乙yi,已yi,以yi,蚁yi,椅yi,倚yi,亿yi,义yi,艺yi,忆yi,议yi,异yi,译yi,易yi',
            '益yi,溢yi,意yi,毅yi,翼yi,因yin,阴yin,音yin,姻yin,银yin,引yin,饮yin,隐yin,印yin,应ying,英ying,樱ying,鹰ying,迎ying,盈ying',
            '营ying,蝇ying,赢ying,影ying,颖ying,硬ying,映ying,哟yo,拥yong,永yong,泳yong,勇yong,涌yong,用yong,优you,忧you,幽you,悠you,尤you,由you',
            '油you,游you,友you,有you,又you,右you,幼you,诱you,于yu,予yu,余yu,鱼yu,娱yu,渔yu,愉yu,逾yu,榆yu,虞yu,愚yu,与yu',
            '宇yu,羽yu,雨yu,语yu,玉yu,育yu,郁yu,狱yu,浴yu,预yu,域yu,欲yu,御yu,裕yu,遇yu,喻yu,寓yu,冤yuan,元yuan,园yuan',
            '原yuan,圆yuan,援yuan,缘yuan,源yuan,远yuan,怨yuan,院yuan,愿yuan,约yue,月yue,越yue,跃yue,阅yue,悦yue,云yun,匀yun,允yun,运yun,蕴yun',
            // Z
            '杂za,砸za,灾zai,栽zai,宰zai,载zai,再zai,在zai,咱zan,攒zan,暂zan,赞zan,脏zang,葬zang,遭zao,糟zao,早zao,澡zao,灶zao,造zao',
            '噪zao,燥zao,责ze,择ze,则ze,泽ze,贼zei,怎zen,增zeng,憎zeng,赠zeng,扎zha,眨zha,炸zha,榨zha,摘zhai,窄zhai,宅zhai,债zhai,沾zhan',
            '斩zhan,展zhan,占zhan,战zhan,站zhan,张zhang,章zhang,涨zhang,掌zhang,丈zhang,仗zhang,帐zhang,账zhang,障zhang,招zhao,找zhao,召zhao,兆zhao,照zhao,罩zhao',
            '遮zhe,折zhe,哲zhe,者zhe,这zhe,浙zhe,针zhen,珍zhen,真zhen,诊zhen,枕zhen,阵zhen,振zhen,镇zhen,震zhen,争zheng,征zheng,挣zheng,睁zheng,蒸zheng',
            '整zheng,正zheng,证zheng,郑zheng,政zheng,症zheng,之zhi,支zhi,汁zhi,芝zhi,枝zhi,知zhi,织zhi,脂zhi,蜘zhi,执zhi,直zhi,值zhi,职zhi,植zhi',
            '殖zhi,止zhi,只zhi,旨zhi,址zhi,纸zhi,指zhi,至zhi,志zhi,制zhi,治zhi,质zhi,致zhi,智zhi,置zhi,中zhong,忠zhong,终zhong,钟zhong,肿zhong',
            '种zhong,众zhong,重zhong,舟zhou,周zhou,洲zhou,州zhou,粥zhou,轴zhou,宙zhou,皱zhou,骤zhou,朱zhu,珠zhu,株zhu,诸zhu,猪zhu,蛛zhu,竹zhu,烛zhu',
            '逐zhu,主zhu,煮zhu,嘱zhu,住zhu,助zhu,注zhu,驻zhu,柱zhu,祝zhu,著zhu,筑zhu,抓zhua,爪zhua,拽zhuai,专zhuan,砖zhuan,转zhuan,赚zhuan,庄zhuang',
            '装zhuang,壮zhuang,状zhuang,撞zhuang,追zhui,坠zhui,准zhun,捉zhuo,桌zhuo,着zhuo,浊zhuo,酌zhuo,啄zhuo,资zi,姿zi,滋zi,子zi,紫zi,字zi,自zi',
            '宗zong,综zong,棕zong,踪zong,总zong,纵zong,走zou,奏zou,揍zou,租zu,足zu,族zu,阻zu,组zu,祖zu,钻zuan,嘴zui,最zui,罪zui,醉zui',
            '尊zun,遵zun,昨zuo,左zuo,作zuo,坐zuo,座zuo,做zuo'
        ];

        data.forEach(line => {
            line.split(',').forEach(item => {
                const match = item.match(/^(.+?)([a-z]+)$/);
                if (match) {
                    COMMON_PINYIN[match[1]] = match[2];
                }
            });
        });
    };

    initCommonPinyin();

    /**
     * 获取单个汉字的拼音
     */
    function getCharPinyin(char) {
        // 先查常用字表
        if (COMMON_PINYIN[char]) {
            return COMMON_PINYIN[char];
        }

        const code = char.charCodeAt(0);
        // 不是汉字，返回原字符
        if (code < 0x4E00 || code > 0x9FFF) {
            return char.toLowerCase();
        }

        // 返回空（未知汉字）
        return '';
    }

    /**
     * 将字符串转换为拼音
     * @param {string} str - 输入字符串
     * @param {Object} options - 选项
     * @param {boolean} options.firstLetter - 是否只返回首字母
     * @param {string} options.separator - 分隔符
     * @returns {string} 拼音字符串
     */
    function toPinyin(str, options = {}) {
        if (!str) return '';

        const { firstLetter = false, separator = '' } = options;
        const result = [];

        for (const char of str) {
            const py = getCharPinyin(char);
            if (py) {
                result.push(firstLetter ? py[0] : py);
            }
        }

        return result.join(separator);
    }

    /**
     * 获取拼音首字母
     */
    function getFirstLetters(str) {
        return toPinyin(str, { firstLetter: true });
    }

    /**
     * 获取完整拼音（用于搜索索引）
     */
    function getFullPinyin(str) {
        return toPinyin(str, { separator: '' });
    }

    /**
     * 为搜索构建拼音索引
     * 返回: "原文 拼音全拼 拼音首字母"
     */
    // 用户自定义词库（从分类、标签等学习）
    const CUSTOM_WORDS = new Set();

    /**
     * 从文本中学习新词（存储原文用于搜索匹配）
     */
    function learnText(text) {
        if (!text || typeof text !== 'string') return;
        text.split(/[\s,，、\/\\|]+/).forEach(word => {
            const w = word.trim();
            if (w && w.length > 0) {
                CUSTOM_WORDS.add(w);
            }
        });
    }

    /**
     * 批量学习多个文本
     */
    function learnTexts(texts) {
        if (!Array.isArray(texts)) return;
        texts.forEach(t => learnText(t));
    }

    /**
     * 获取所有已学习的词
     */
    function getLearnedWords() {
        return Array.from(CUSTOM_WORDS);
    }

    function buildSearchPinyin(str) {
        if (!str) return '';
        const full = getFullPinyin(str);
        const first = getFirstLetters(str);
        // 去重并返回
        const parts = [str];
        if (full && full !== str.toLowerCase()) parts.push(full);
        if (first && first !== full) parts.push(first);
        return parts.join(' ');
    }

    // 导出
    const Pinyin = {
        toPinyin,
        getFirstLetters,
        getFullPinyin,
        buildSearchPinyin,
        learnText,
        learnTexts,
        getLearnedWords,
        // 允许扩展字典
        extend(dict) {
            Object.assign(COMMON_PINYIN, dict);
        }
    };

    // UMD 导出
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Pinyin;
    } else {
        global.Pinyin = Pinyin;
    }

})(typeof window !== 'undefined' ? window : this);
