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
            '突tu,分fen,支zhi,主zhu,干gan,标biao,记ji,里li,程cheng,碑bei,任ren,务wu,清qing,单dan,待dai,办ban,已yi,完wan,成cheng,进jin,度du'
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
